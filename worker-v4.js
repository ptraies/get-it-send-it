import baseWorker from "./worker-v2.js";

const HM_HOSTS = new Set(["hm.com", "www.hm.com", "www2.hm.com"]);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
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
  const n = Number.parseFloat(cleaned.replace(/,(?=\d{3}(?:\D|$))/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function browserHMProduct(env, productUrl, articleCode, diagnostics = false) {
  const result = {
    stage: "browser_start",
    bindingPresent: Boolean(env?.BROWSER),
    quickActionPresent: Boolean(env?.BROWSER?.quickAction),
    url: productUrl,
    articleCode
  };

  if (!env?.BROWSER?.quickAction) {
    result.stage = "browser_binding_missing";
    return diagnostics ? result : null;
  }

  try {
    result.stage = "browser_call_started";
    const response = await env.BROWSER.quickAction("json", {
      url: productUrl,
      prompt: `Extract the product currently shown on this H&M UK product page. The article code in the URL is ${articleCode}. Return the price for this exact product in GBP, not a price from another product, recommendation, promotion, shipping option, or navigation element. If the product is on sale, return the current selling price. Also return the product name and whether the exact product appears available.`,
      gotoOptions: { waitUntil: "networkidle2" },
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
            currency: { type: "string" },
            availability: { type: "string" }
          },
          required: ["price"]
        }
      }
    });

    result.stage = "browser_response_received";
    result.httpStatus = response?.status ?? null;
    result.contentType = response?.headers?.get("content-type") || null;
    result.browserMsUsed = response?.headers?.get("X-Browser-Ms-Used") || null;

    const raw = await response.clone().text();
    result.rawPreview = raw.slice(0, 2000);

    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      result.stage = "browser_non_json_response";
      result.parseError = String(error?.message || error);
      return diagnostics ? result : null;
    }

    result.responseKeys = Object.keys(data || {});
    const extracted = data?.result || data?.data || null;
    result.extracted = extracted;

    const price = cleanPrice(extracted?.price);
    result.normalisedPrice = price;

    if (price === null || price <= 0 || price >= 100000) {
      result.stage = "browser_invalid_price";
      return diagnostics ? result : null;
    }

    result.stage = "browser_success";

    return diagnostics
      ? result
      : {
          name: extracted?.name || null,
          price,
          currency: String(extracted?.currency || "GBP").toUpperCase(),
          availability: extracted?.availability || null,
          articleCode,
          source: "cloudflare_browser_json"
        };
  } catch (error) {
    result.stage = "browser_exception";
    result.errorName = error?.name || null;
    result.errorMessage = String(error?.message || error);
    result.errorStack = error?.stack ? String(error.stack).slice(0, 3000) : null;
    return diagnostics ? result : null;
  }
}

async function probeHM(url, articleCode) {
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
    let json = null;
    try { json = JSON.parse(text); } catch {}

    let productHit = null;
    const seen = new Set();
    const walk = (value) => {
      if (productHit || value == null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      const hasArticle = Object.entries(value).some(([k, v]) => /article(code|_code|id)?|product(code|_code|id)?|sku/i.test(k) && String(v) === String(articleCode));
      if (hasArticle) {
        for (const [k, v] of Object.entries(value)) {
          if (/price|sellingPrice|currentPrice|listPrice|formattedPrice/i.test(k)) {
            const price = cleanPrice(v);
            if (price !== null && price > 0 && price < 100000) {
              productHit = { matchedKey: k, price, name: value.name || value.title || value.productName || null, currency: value.currency || value.priceCurrency || value.currencyCode || "GBP" };
              break;
            }
          }
        }
      }
      for (const child of Object.values(value)) walk(child);
    };
    if (json) walk(json);

    return {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      finalUrl: response.url,
      ms: Date.now() - started,
      productHit,
      preview: text.slice(0, 1800)
    };
  } catch (error) {
    return { url, status: null, ms: Date.now() - started, error: String(error?.message || error) };
  }
}

async function hmApiDiagnostics(articleCode) {
  const code = String(articleCode || "");
  const candidates = [
    `https://www2.hm.com/hmwebservices/service/product/gb/availability/${code.slice(0, 7)}.json`,
    `https://api.hm.com/search-services/v1/en_gb/listing/resultpage?query=${encodeURIComponent(code)}&page=1&pageSize=72`,
    `https://api.hm.com/search-services/v1/en_gb/listing/resultpage?q=${encodeURIComponent(code)}&page=1&pageSize=72`,
    `https://api.hm.com/search-services/v1/en_gb/listing/resultpage?searchTerm=${encodeURIComponent(code)}&page=1&pageSize=72`
  ];
  return Promise.all(candidates.map(url => probeHM(url, code)));
}

async function calculateEstimate(request, env, product) {
  const incoming = new URL(request.url);
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", incoming.searchParams.get("destination") || "");

  try {
    const response = await baseWorker.fetch(new Request(estimateUrl.toString(), { method: "GET" }), env);
    const data = await response.json();
    if (!data || data.success === false) return null;

    return {
      ...data,
      success: true,
      product: {
        ...(data.product || {}),
        name: product.name || data.product?.name || null,
        price: product.price,
        currency: product.currency || "GBP",
        priceGbp: (product.currency || "GBP") === "GBP" ? product.price : data.product?.priceGbp,
        availability: product.availability
      },
      lookupMethod: product.source,
      articleCode: product.articleCode
    };
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-hm-api" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      if (!articleCode) return jsonResponse({ success: false, error: "Invalid H&M product URL." }, 400);
      return jsonResponse({ success: true, articleCode, probes: await hmApiDiagnostics(articleCode) });
    }

    if (url.pathname === "/api/debug-product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      const diagnostics = productUrl && articleCode
        ? await browserHMProduct(env, productUrl, articleCode, true)
        : { stage: "invalid_input", url: productUrl, articleCode };

      return jsonResponse({
        success: diagnostics?.stage === "browser_success",
        diagnostics
      }, diagnostics?.stage === "browser_success" ? 200 : 502);
    }

    if (url.pathname === "/api/product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;

      if (productUrl && articleCode) {
        const product = await browserHMProduct(env, productUrl, articleCode);
        if (product) {
          const estimate = await calculateEstimate(request, env, product);
          if (estimate) return jsonResponse(estimate);

          return jsonResponse({
            success: true,
            product: {
              name: product.name,
              price: product.price,
              currency: product.currency,
              priceGbp: product.currency === "GBP" ? product.price : null,
              availability: product.availability
            },
            lookupMethod: product.source,
            articleCode: product.articleCode,
            serviceFee: { status: "confirmed", amount: 15 },
            warning: "H&M product price was found automatically, but the full delivery estimate could not be calculated."
          });
        }

        return baseWorker.fetch(request, env);
      }
    }

    return baseWorker.fetch(request, env);
  }
};
