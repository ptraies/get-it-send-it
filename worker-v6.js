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

async function fetchShopifyProductFixed(productUrl) {
  let url;
  try {
    url = new URL(productUrl);
  } catch {
    return null;
  }

  const match = url.pathname.match(/\/products\/([^/?#]+)/i);
  if (!match) return null;

  const handle = decodeURIComponent(match[1]);
  const endpoint = `${url.origin}/products/${encodeURIComponent(handle)}.js`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.5; +https://getitsendit.co.uk)"
      },
      redirect: "follow",
      cache: "no-store"
    });
    if (!response.ok) return null;

    const data = await response.json();
    const variants = Array.isArray(data?.variants) ? data.variants : [];
    const available = variants.find(v => v && v.available && v.price !== undefined);
    const variant = available || variants.find(v => v?.price !== undefined);
    const raw = data?.price ?? data?.price_min ?? variant?.price;
    const numeric = cleanPrice(raw);
    if (numeric === null || numeric <= 0) return null;

    // Shopify Ajax Product API monetary fields are returned in the currency
    // subunit (e.g. 799 means £7.99; 79900 means £799.00).
    const price = numeric / 100;
    if (!Number.isFinite(price) || price <= 0 || price >= 100000) return null;

    return {
      name: data?.title || null,
      price,
      currency: String(data?.currency || "GBP").toUpperCase(),
      availability: data?.available === false ? "OutOfStock" : data?.available === true ? "InStock" : null,
      source: "shopify_ajax_fixed"
    };
  } catch {
    return null;
  }
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
        productOptions: { extractFrom, ai: true }
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

async function getZyteProduct(env, productUrl) {
  const isHmUk = (() => {
    try {
      const u = new URL(productUrl);
      return HM_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.toLowerCase().includes("/en_gb/");
    } catch {
      return false;
    }
  })();

  const http = await zyteProduct(env, productUrl, "httpResponseBody");
  if (http.ok) return { ...http, source: "zyte_http_product" };

  const browser = await zyteProduct(env, productUrl, "browserHtml", {
    retry520: true,
    ...(isHmUk ? { geolocation: "GB" } : {})
  });
  if (browser.ok) return { ...browser, source: "zyte_browser_product" };

  return {
    ok: false,
    reason: env?.ZYTE_API_KEY ? "zyte_no_product_price" : "zyte_api_key_missing",
    http,
    browser
  };
}

function addPngImportTax(data, destination) {
  if (destination !== "PG" || !data) return data;
  const product = Number(data.product?.amount ?? data.product?.priceGbp);
  const uk = data.ukShipping;
  const dest = data.destinationShipping;
  const ukAmount = uk?.status === "confirmed" && Number.isFinite(Number(uk.amount)) ? Number(uk.amount) : 0;
  const lowShipping = Number(dest?.low);
  const highShipping = Number(dest?.high);

  if (!Number.isFinite(product) || !Number.isFinite(lowShipping) || !Number.isFinite(highShipping)) return data;

  const customsLow = product + ukAmount + lowShipping;
  const customsHigh = product + ukAmount + highShipping;
  const lowTax = customsLow * 0.10;
  const highTax = customsHigh * 0.10;

  const previous = data.importTax || {};
  const dutyUnknown = data.customsDuty?.status === "unknown";
  const unresolved = Array.isArray(data.unresolved) ? data.unresolved.filter(x => x !== "Destination import taxes") : [];
  if (dutyUnknown && !unresolved.includes("Customs duty")) unresolved.push("Customs duty");

  const low = product + Number(data.serviceFee?.amount || 0) + ukAmount + lowShipping + lowTax;
  const high = product + Number(data.serviceFee?.amount || 0) + ukAmount + highShipping + highTax;

  return {
    ...data,
    importTax: {
      status: "indicative",
      low: lowTax,
      high: highTax,
      label: "Potential GST",
      basis: "Indicative 10% PNG GST applied to the estimated customs-value range. This does not include potentially applicable duty, exemptions or carrier/clearance charges."
    },
    total: {
      ...(data.total || {}),
      status: unresolved.length === 0 ? "estimated" : "partial",
      low,
      high,
      currency: "GBP"
    },
    unresolved
  };
}

async function calculateEstimate(request, env, product) {
  const incoming = new URL(request.url);
  const destination = (incoming.searchParams.get("destination") || "").toUpperCase().trim();
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", destination);

  try {
    const response = await baseWorker.fetch(new Request(estimateUrl.toString(), { method: "GET" }), env);
    const data = await response.json();
    if (!data?.success) return null;
    return addPngImportTax(data, destination);
  } catch {
    return null;
  }
}

async function handleProduct(request, env) {
  const incoming = new URL(request.url);
  const productUrl = incoming.searchParams.get("url");
  const destination = (incoming.searchParams.get("destination") || "").toUpperCase().trim();

  if (!productUrl || !destination) return baseWorker.fetch(request, env);

  // Shopify Ajax uses subunit monetary values. Handle it explicitly so
  // values such as 799 become £7.99 rather than £799.00.
  const shopify = await fetchShopifyProductFixed(productUrl);
  if (shopify) {
    const estimate = await calculateEstimate(request, env, shopify);
    if (estimate) {
      return jsonResponse({
        ...estimate,
        success: true,
        product: {
          ...(estimate.product || {}),
          name: shopify.name,
          price: shopify.price,
          currency: shopify.currency,
          priceGbp: shopify.currency === "GBP" ? shopify.price : estimate.product?.priceGbp,
          availability: shopify.availability
        },
        lookupMethod: shopify.source,
        sourceUrl: productUrl
      });
    }
  }

  // Generic path: existing free resolver first, then Zyte only when it
  // doesn't return a usable price. This remains retailer-agnostic.
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
      articleCode: getHMArticleCode(productUrl),
      name: zyte.product?.name || null,
      price: zyte.price,
      currency,
      availability: zyte.product?.availability || null,
      source: zyte.source
    };

    const estimate = await calculateEstimate(request, env, product);
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

    if (url.pathname === "/api/product" && request.method === "GET") return handleProduct(request, env);

    if (url.pathname === "/api/estimate" && request.method === "GET") {
      const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();
      const response = await baseWorker.fetch(request, env);
      let data = null;
      try { data = await response.clone().json(); } catch {}
      if (data?.success) return jsonResponse(addPngImportTax(data, destination), response.status);
      return response;
    }

    return baseWorker.fetch(request, env);
  }
};
