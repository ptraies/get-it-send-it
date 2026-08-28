import currentWorker from "./worker-v5.js";

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
  const normalised = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const number = Number.parseFloat(normalised);
  return Number.isFinite(number) ? number : null;
}

function getAuthHeader(apiKey) {
  const bytes = new TextEncoder().encode(`${apiKey}:`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function zyteProduct(env, productUrl, extractFrom) {
  if (!env?.ZYTE_API_KEY) {
    return { ok: false, reason: "zyte_api_key_missing", extractFrom };
  }

  try {
    const response = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "Authorization": getAuthHeader(env.ZYTE_API_KEY),
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        url: productUrl,
        product: true,
        productOptions: {
          extractFrom
        }
      })
    });

    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const product = data?.product || null;
    const price = cleanPrice(product?.price);
    const currency = String(product?.currency || "").toUpperCase();
    const probability = Number(product?.metadata?.probability ?? 0);

    return {
      ok: response.ok && !!product && price !== null && price > 0 && currency,
      status: response.status,
      extractFrom,
      price,
      currency,
      probability,
      product,
      responsePreview: response.ok ? null : text.slice(0, 1500)
    };
  } catch (error) {
    return {
      ok: false,
      reason: "zyte_request_failed",
      extractFrom,
      error: String(error?.message || error)
    };
  }
}

async function getZyteProduct(env, productUrl) {
  // Cheapest/fastest path first. Only pay for browser rendering when the
  // ordinary HTTP response doesn't contain a usable product price.
  const http = await zyteProduct(env, productUrl, "httpResponseBody");
  if (http.ok && http.probability >= 0.5) return { ...http, source: "zyte_http_product" };

  const browser = await zyteProduct(env, productUrl, "browserHtml");
  if (browser.ok && browser.probability >= 0.5) return { ...browser, source: "zyte_browser_product" };

  // Keep a usable extraction even when Zyte's probability is conservative,
  // provided it returned a positive price.
  if (http.ok) return { ...http, source: "zyte_http_product" };
  if (browser.ok) return { ...browser, source: "zyte_browser_product" };

  return {
    ok: false,
    reason: env?.ZYTE_API_KEY ? "zyte_no_product_price" : "zyte_api_key_missing",
    http,
    browser
  };
}

async function estimateFromCurrentWorker(request, env, product) {
  const incoming = new URL(request.url);
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", incoming.searchParams.get("destination") || "");

  try {
    const response = await currentWorker.fetch(new Request(estimateUrl.toString(), { method: "GET" }), env);
    const data = await response.json();
    return data?.success ? data : null;
  } catch {
    return null;
  }
}

async function normaliseEstimate(request, env, product, sourceUrl) {
  const estimate = await estimateFromCurrentWorker(request, env, product);
  if (estimate) {
    return {
      ...estimate,
      success: true,
      product: {
        ...(estimate.product || {}),
        name: product.name || estimate.product?.name || null,
        price: product.price,
        currency: product.currency,
        priceGbp: product.currency === "GBP" ? product.price : estimate.product?.priceGbp,
        availability: product.availability || estimate.product?.availability || null
      },
      lookupMethod: product.source,
      articleCode: product.articleCode || null,
      sourceUrl
    };
  }

  return {
    success: true,
    product: {
      name: product.name || null,
      price: product.price,
      currency: product.currency,
      priceGbp: product.currency === "GBP" ? product.price : null,
      availability: product.availability || null
    },
    lookupMethod: product.source,
    articleCode: product.articleCode || null,
    sourceUrl,
    serviceFee: { status: "confirmed", amount: 15 },
    warning: "The product price was found automatically, but the full delivery estimate could not be calculated."
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-zyte" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      if (!productUrl) return jsonResponse({ success: false, error: "Missing product URL." }, 400);

      const result = await getZyteProduct(env, productUrl);
      return jsonResponse({
        success: result.ok,
        zyteConfigured: Boolean(env?.ZYTE_API_KEY),
        result
      }, result.ok ? 200 : 502);
    }

    if (url.pathname === "/api/product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();

      if (productUrl && destination) {
        // First let the existing/native resolver have a go. This keeps easy
        // retailers free and preserves all current estimate logic.
        try {
          const nativeResponse = await currentWorker.fetch(request, env);
          const nativeText = await nativeResponse.clone().text();
          let nativeData = null;
          try { nativeData = JSON.parse(nativeText); } catch {}
          const nativePrice = cleanPrice(nativeData?.product?.priceGbp);
          if (nativeData?.success && nativePrice !== null && nativePrice > 0) {
            return new Response(nativeText, {
              status: nativeResponse.status,
              headers: nativeResponse.headers
            });
          }
        } catch {}

        const zyte = await getZyteProduct(env, productUrl);
        if (zyte.ok) {
          const currency = String(zyte.currency || "GBP").toUpperCase();
          const product = {
            articleCode: getHMArticleCode(productUrl),
            name: zyte.product?.name || null,
            price: zyte.price,
            currency,
            availability: zyte.product?.availability || null,
            source: zyte.source
          };
          return jsonResponse(await normaliseEstimate(request, env, product, productUrl));
        }
      }

      return currentWorker.fetch(request, env);
    }

    return currentWorker.fetch(request, env);
  }
};
