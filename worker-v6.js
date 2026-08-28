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

function getArticleCode(value) {
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

async function zyteProduct(env, productUrl, extractFrom, options = {}) {
  if (!env?.ZYTE_API_KEY) return { ok: false, reason: "zyte_api_key_missing", extractFrom };

  const maxAttempts = options.retry520 ? 3 : 1;
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = {
        url: productUrl,
        product: true,
        productOptions: {
          extractFrom,
          ai: true
        }
      };

      if (extractFrom === "browserHtml") body.browserHtml = true;
      if (extractFrom === "httpResponseBody") body.httpResponseBody = true;
      if (options.geolocation) body.geolocation = options.geolocation;

      const response = await fetch("https://api.zyte.com/v1/extract", {
        method: "POST",
        headers: {
          "Authorization": getAuthHeader(env.ZYTE_API_KEY),
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}

      const product = data?.product || null;
      const price = cleanPrice(product?.price);
      const currency = String(product?.currency || "").toUpperCase();
      const probability = Number(product?.metadata?.probability ?? 0);

      attempts.push({ attempt, status: response.status, price, currency, probability, ok: response.ok });

      const result = {
        ok: response.ok && !!product && price !== null && price > 0 && !!currency,
        status: response.status,
        extractFrom,
        price,
        currency,
        probability,
        product,
        attempts,
        responsePreview: response.ok ? null : text.slice(0, 1500)
      };

      if (result.ok || response.status !== 520 || attempt === maxAttempts) return result;
      await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    } catch (error) {
      attempts.push({ attempt, networkError: String(error?.message || error) });
      if (attempt === maxAttempts) {
        return { ok: false, reason: "zyte_request_failed", extractFrom, attempts, error: String(error?.message || error) };
      }
    }
  }

  return { ok: false, reason: "zyte_request_failed", extractFrom, attempts };
}

function zyteOptions(productUrl) {
  try {
    const url = new URL(productUrl);
    if (HM_HOSTS.has(url.hostname.toLowerCase()) && url.pathname.toLowerCase().includes("/en_gb/")) {
      return { retry520: true, geolocation: "GB" };
    }
  } catch {}
  return { retry520: true };
}

async function getZyteProduct(env, productUrl) {
  const options = zyteOptions(productUrl);

  const http = await zyteProduct(env, productUrl, "httpResponseBody");
  if (http.ok) return { ...http, source: "zyte_http_product" };

  const browser = await zyteProduct(env, productUrl, "browserHtml", options);
  if (browser.ok) return { ...browser, source: "zyte_browser_product" };

  return {
    ok: false,
    reason: env?.ZYTE_API_KEY ? "zyte_no_product_price" : "zyte_api_key_missing",
    http,
    browser
  };
}

async function estimateFromBase(request, env, product) {
  const incoming = new URL(request.url);
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", incoming.searchParams.get("destination") || "");

  try {
    const response = await baseWorker.fetch(new Request(estimateUrl.toString(), { method: "GET" }), env);
    const data = await response.json();
    return data?.success ? data : null;
  } catch {
    return null;
  }
}

async function handleProduct(request, env) {
  const incoming = new URL(request.url);
  const productUrl = incoming.searchParams.get("url");
  const destination = (incoming.searchParams.get("destination") || "").toUpperCase().trim();

  if (!productUrl || !destination) return baseWorker.fetch(request, env);

  // Let the generic resolver handle straightforward stores first. This is
  // worker-v2 and deliberately does not invoke the old H&M-specific browser
  // lookup that was returning the misleading £3.99 result.
  try {
    const native = await baseWorker.fetch(request, env);
    const nativeText = await native.clone().text();
    let nativeData = null;
    try { nativeData = JSON.parse(nativeText); } catch {}
    const nativePrice = cleanPrice(nativeData?.product?.priceGbp ?? nativeData?.product?.price);
    if (nativeData?.success && nativePrice !== null && nativePrice > 0) {
      return new Response(nativeText, { status: native.status, headers: native.headers });
    }
  } catch {}

  const zyte = await getZyteProduct(env, productUrl);
  if (zyte.ok) {
    const currency = String(zyte.currency || "GBP").toUpperCase();
    const product = {
      articleCode: getArticleCode(productUrl),
      name: zyte.product?.name || null,
      price: zyte.price,
      currency,
      availability: zyte.product?.availability || null,
      source: zyte.source
    };

    const estimate = await estimateFromBase(request, env, product);
    if (estimate) {
      return jsonResponse({
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
        articleCode: product.articleCode,
        sourceUrl: productUrl
      });
    }

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
      sourceUrl: productUrl,
      serviceFee: { status: "confirmed", amount: 15 },
      warning: "The product price was found automatically, but the full delivery estimate could not be calculated."
    });
  }

  // Keep the generic resolver's normal manual-price fallback rather than
  // allowing an older retailer-specific extractor to supply a potentially
  // incorrect price.
  return baseWorker.fetch(request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-zyte" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      if (!productUrl) return jsonResponse({ success: false, error: "Missing product URL." }, 400);
      const result = await getZyteProduct(env, productUrl);
      return jsonResponse({ success: result.ok, zyteConfigured: Boolean(env?.ZYTE_API_KEY), result }, result.ok ? 200 : 502);
    }

    if (url.pathname === "/api/product" && request.method === "GET") {
      return handleProduct(request, env);
    }

    return baseWorker.fetch(request, env);
  }
};
