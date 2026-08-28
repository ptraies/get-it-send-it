import currentWorker from "./worker-v4.js";

const HM_HOSTS = new Set(["hm.com", "www.hm.com", "www2.hm.com"]);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

function getHMArticleCode(value) {
  try {
    const url = new URL(value);
    if (!HM_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/\/productpage\.(\d+)\.html(?:$|\/)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function cleanPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^0-9.,-]/g, "").trim();
  if (!cleaned) return null;
  const normalised = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const number = Number.parseFloat(normalised);
  return Number.isFinite(number) ? number : null;
}

async function probeHMDetail(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.4; +https://getitsendit.co.uk)",
        "Referer": "https://www2.hm.com/en_gb/"
      },
      redirect: "follow",
      cache: "no-store"
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    let price = null;
    let product = null;
    if (data && typeof data === "object") {
      const seen = new Set();
      const walk = (value) => {
        if (price !== null || value == null || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) { for (const item of value) walk(item); return; }
        for (const [key, valuePart] of Object.entries(value)) {
          if (price === null && /(^price$|sellingPrice|currentPrice|whitePrice|listPrice|formattedPrice)/i.test(key)) {
            const candidate = cleanPrice(valuePart);
            if (candidate !== null && candidate > 0 && candidate < 100000) price = candidate;
          }
        }
        if (!product && /product|article|name|title/i.test(Object.keys(value).join(" "))) product = value;
        for (const child of Object.values(value)) walk(child);
      };
      walk(data);
    }

    return {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      finalUrl: response.url,
      ms: Date.now() - started,
      price,
      preview: text.slice(0, 2500),
      topLevelKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 30) : []
    };
  } catch (error) {
    return { url, status: null, ms: Date.now() - started, error: String(error?.message || error) };
  }
}

async function searchHMWithBrowser(env, articleCode) {
  const searchUrl = `https://www2.hm.com/en_gb/search-results.html?q=${encodeURIComponent(articleCode)}`;
  if (!env?.BROWSER?.quickAction) return { ok: false, reason: "browser_binding_missing" };

  try {
    const response = await env.BROWSER.quickAction("json", {
      url: searchUrl,
      prompt: `You are on an H&M UK search-results page. Locate the exact product whose article code is ${articleCode}. Do not return another product. Return JSON with exactArticleCode, name, productUrl, price, currency. The price must be the current selling price for that exact article, in GBP. If there is no exact match, return exactArticleCode as an empty string and price as 0.`,
      gotoOptions: { waitUntil: "networkidle2" },
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            exactArticleCode: { type: "string" },
            name: { type: "string" },
            productUrl: { type: "string" },
            price: { type: "number" },
            currency: { type: "string" }
          },
          required: ["exactArticleCode", "price"]
        }
      }
    });

    const raw = await response.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch {}
    const data = payload?.result || payload?.data || payload || {};
    const exactArticleCode = String(data.exactArticleCode || "").trim();
    const price = cleanPrice(data.price);

    if (exactArticleCode !== articleCode || price === null || price <= 0) {
      return {
        ok: false,
        reason: "exact_match_not_found",
        status: response.status,
        rawPreview: raw.slice(0, 2500),
        data
      };
    }

    return {
      ok: true,
      product: {
        articleCode,
        name: data.name || null,
        productUrl: data.productUrl || searchUrl,
        price,
        currency: String(data.currency || "GBP").toUpperCase(),
        source: "hm_browser_search"
      },
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: "browser_exception",
      error: String(error?.message || error)
    };
  }
}

async function estimateFromCurrentWorker(request, product) {
  const incoming = new URL(request.url);
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", incoming.searchParams.get("destination") || "");

  const response = await currentWorker.fetch(new Request(estimateUrl.toString(), { method: "GET" }), {});
  let data = null;
  try { data = await response.json(); } catch {}
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-hm-detail" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      if (!articleCode) return jsonResponse({ success: false, error: "Invalid H&M product URL." }, 400);
      const base = articleCode.slice(0, 7);
      const candidates = [
        `https://api.hm.com/product-services/v1/en_gb/articles/${articleCode}`,
        `https://api.hm.com/product-services/v1/en_gb/products/${articleCode}`,
        `https://api.hm.com/product-service/v1/en_gb/articles/${articleCode}`,
        `https://api.hm.com/product-service/v1/en_gb/products/${articleCode}`,
        `https://api.hm.com/products/v1/en_gb/articles/${articleCode}`,
        `https://api.hm.com/articles/v1/en_gb/${articleCode}`,
        `https://www2.hm.com/hmwebservices/service/product/gb/availability/${base}.json`,
        `https://tags.tiqcdn.com/dle/hm/hdl/${articleCode}.json`
      ];
      return jsonResponse({ success: true, articleCode, probes: await Promise.all(candidates.map(probeHMDetail)) });
    }

    if (url.pathname === "/api/debug-hm-search" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      if (!articleCode) return jsonResponse({ success: false, error: "Invalid H&M product URL." }, 400);
      return jsonResponse({ success: true, articleCode, search: await searchHMWithBrowser(env, articleCode) });
    }

    if (url.pathname === "/api/product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();

      if (productUrl && articleCode && destination) {
        const result = await searchHMWithBrowser(env, articleCode);
        if (result.ok) {
          const estimate = await estimateFromCurrentWorker(request, result.product);
          if (estimate?.success) {
            return jsonResponse({
              ...estimate,
              success: true,
              product: {
                ...(estimate.product || {}),
                name: result.product.name,
                price: result.product.price,
                currency: result.product.currency,
                priceGbp: result.product.currency === "GBP" ? result.product.price : estimate.product?.priceGbp,
                availability: estimate.product?.availability || null
              },
              lookupMethod: "hm_browser_search",
              articleCode,
              sourceUrl: productUrl
            });
          }

          return jsonResponse({
            success: true,
            product: {
              name: result.product.name,
              price: result.product.price,
              currency: result.product.currency,
              priceGbp: result.product.currency === "GBP" ? result.product.price : null,
              availability: null
            },
            lookupMethod: "hm_browser_search",
            articleCode,
            serviceFee: { status: "confirmed", amount: 15 },
            warning: "The H&M price was found automatically, but the rest of the estimate could not be calculated."
          });
        }
      }

      return currentWorker.fetch(request, env);
    }

    return currentWorker.fetch(request, env);
  }
};
