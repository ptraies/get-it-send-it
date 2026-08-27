import legacyWorker from "./worker.js";

const SHOPIFY_USER_AGENT =
  "Mozilla/5.0 (compatible; GetItSendIt/1.4; +https://getitsendit.co.uk)";

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

function normaliseCurrency(currency) {
  if (!currency) return null;
  const value = String(currency).toUpperCase().trim();
  return ({ "£": "GBP", "$": "USD", "€": "EUR" })[value] || value;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || !parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function cleanPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^0-9.,-]/g, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function getShopifyProductUrl(productUrl) {
  const url = new URL(productUrl);
  const match = url.pathname.match(/\/products\/([^/?#]+)/i);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]);
  return `${url.origin}/products/${encodeURIComponent(handle)}.js`;
}

async function fetchShopifyProduct(productUrl) {
  let endpoint;
  try { endpoint = getShopifyProductUrl(productUrl); } catch { return null; }
  if (!endpoint) return null;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": SHOPIFY_USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Referer": productUrl,
        "Cache-Control": "no-cache"
      },
      redirect: "follow",
      cache: "no-store"
    });
    if (!response.ok) return null;

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return null; }

    const variants = Array.isArray(data.variants) ? data.variants : [];
    const available = variants.find(v => v && v.available && cleanPrice(v.price) !== null);
    const variant = available || variants.find(v => cleanPrice(v?.price) !== null);

    let price = cleanPrice(data.price ?? data.price_min ?? variant?.price);
    if (price === null) return null;
    if (price > 10000) price /= 100;

    return {
      name: data.title || null,
      price,
      currency: normaliseCurrency(data.currency) || "GBP",
      availability: data.available === false ? "OutOfStock" : data.available === true ? "InStock" : null,
      source: "shopify_ajax"
    };
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.4; +https://getitsendit.co.uk)",
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      cache: "no-store"
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("html")) return null;
    return { html: await response.text(), finalUrl: response.url };
  } catch {
    return null;
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&pound;|&#163;/gi, "£")
    .replace(/&euro;|&#8364;/gi, "€")
    .replace(/&dollar;|&#36;/gi, "$")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseJsonLdProduct(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = parseJsonLdProduct(item);
      if (result) return result;
    }
    return null;
  }

  const type = Array.isArray(value["@type"]) ? value["@type"].map(String).join(" ") : String(value["@type"] || "");
  if (/product/i.test(type)) {
    const offers = Array.isArray(value.offers) ? value.offers : value.offers ? [value.offers] : [];
    for (const offer of offers) {
      const price = cleanPrice(offer?.price);
      if (price !== null) {
        return {
          name: value.name || null,
          price,
          currency: normaliseCurrency(offer.priceCurrency) || "GBP",
          availability: offer.availability || null,
          source: "json_ld"
        };
      }
    }
  }

  for (const child of Object.values(value)) {
    const result = parseJsonLdProduct(child);
    if (result) return result;
  }
  return null;
}

function extractJsonLdPrice(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const result = parseJsonLdProduct(JSON.parse(decodeHtml(match[1].trim())));
      if (result) return result;
    } catch {}
  }
  return null;
}

function extractMetaPrice(html) {
  const candidates = [];
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount|twitter:data1|price|product_price)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount|twitter:data1|price|product_price)["'][^>]*>/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const price = cleanPrice(decodeHtml(match[1]));
      if (price !== null && price > 0 && price < 100000) candidates.push(price);
    }
  }

  if (!candidates.length) return null;

  const currencyMatch = html.match(/(?:product:price:currency|og:price:currency)["'][^>]+content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["'][^>]+(?:product:price:currency|og:price:currency)["']/i);
  return {
    name: null,
    price: candidates[0],
    currency: normaliseCurrency(currencyMatch?.[1]) || "GBP",
    availability: null,
    source: "meta"
  };
}

function extractVisiblePrice(html) {
  // Last-resort extraction for modern server-rendered product pages. We only
  // inspect small regions that identify themselves as price/product markup;
  // this avoids grabbing arbitrary £ amounts from navigation or promotions.
  const regions = [];
  const patterns = [
    /<(?:div|span|p)[^>]+(?:class|id)=["'][^"']*(?:price|product-price|selling-price|current-price)[^"']*["'][^>]*>([\s\S]{0,500})<\/(?:div|span|p)>/gi,
    /<(?:div|span|p)[^>]+(?:data-price|data-product-price)=["']([^"']+)["'][^>]*>/gi,
    /<(?:div|span|p)[^>]+itemprop=["']price["'][^>]*>([\s\S]{0,200})<\/(?:div|span|p)>/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      regions.push(decodeHtml(match[1]));
    }
  }

  const prices = [];
  for (const region of regions) {
    const matches = region.match(/(?:£|GBP\s*)\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/gi) || [];
    for (const match of matches) {
      const price = cleanPrice(match);
      if (price !== null && price > 0 && price < 100000) prices.push(price);
    }
  }

  if (!prices.length) return null;
  return { name: null, price: prices[0], currency: "GBP", availability: null, source: "visible_price" };
}

function extractGenericProduct(html) {
  return extractJsonLdPrice(html) || extractMetaPrice(html) || extractVisiblePrice(html);
}

async function callLegacy(request, env) {
  try { return await legacyWorker.fetch(request, env); } catch { return null; }
}

async function readJson(response) {
  if (!response) return null;
  try { return await response.clone().json(); } catch { return null; }
}

async function calculateWithLegacy(request, env, product, ukShipping = null) {
  const destination = new URL(request.url).searchParams.get("destination") || "";
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", destination);
  if (ukShipping !== null) estimateUrl.searchParams.set("ukShipping", String(ukShipping));

  const estimateResponse = await callLegacy(new Request(estimateUrl.toString(), { method: "GET" }), env);
  return readJson(estimateResponse);
}

function addProductToEstimate(data, product, lookupMethod) {
  return {
    ...(data || {}),
    success: true,
    product: {
      ...(data?.product || {}),
      name: product.name,
      price: product.price,
      currency: product.currency,
      priceGbp: product.currency === "GBP" ? product.price : data?.product?.priceGbp,
      availability: product.availability
    },
    lookupMethod
  };
}

async function handleProduct(request, env, target) {
  // Shopify is the most deterministic route and remains first for Shopify URLs.
  const shopify = await fetchShopifyProduct(target.toString());
  if (shopify) {
    const legacyResponse = await callLegacy(request, env);
    const legacyData = await readJson(legacyResponse);
    const ukShipping = legacyData?.ukShipping?.status === "confirmed" && Number.isFinite(legacyData.ukShipping.amount)
      ? legacyData.ukShipping.amount
      : null;

    const estimate = await calculateWithLegacy(request, env, shopify, ukShipping);
    if (estimate?.success) return jsonResponse(addProductToEstimate(estimate, shopify, "shopify_ajax"));

    return jsonResponse({
      success: true,
      product: { name: shopify.name, price: shopify.price, currency: shopify.currency, priceGbp: shopify.currency === "GBP" ? shopify.price : null, availability: shopify.availability },
      ukShipping: ukShipping === null ? { status: "unknown", amount: null } : { status: "confirmed", amount: ukShipping },
      serviceFee: { status: "confirmed", amount: 15 },
      lookupMethod: "shopify_ajax",
      warning: "Product price confirmed by the retailer's product data. Some destination charges could not be calculated automatically."
    });
  }

  // Generic fallback for non-Shopify stores such as Oliver Bonas.
  const page = await fetchPage(target.toString());
  if (!page) return null;

  const product = extractGenericProduct(page.html);
  if (!product) return null;

  const legacyResponse = await callLegacy(request, env);
  const legacyData = await readJson(legacyResponse);
  const ukShipping = legacyData?.ukShipping?.status === "confirmed" && Number.isFinite(legacyData.ukShipping.amount)
    ? legacyData.ukShipping.amount
    : null;

  const estimate = await calculateWithLegacy(request, env, product, ukShipping);
  if (estimate?.success) return jsonResponse(addProductToEstimate(estimate, product, product.source));

  return jsonResponse({
    success: true,
    product: {
      name: product.name,
      price: product.price,
      currency: product.currency,
      priceGbp: product.currency === "GBP" ? product.price : null,
      availability: product.availability
    },
    ukShipping: ukShipping === null ? { status: "unknown", amount: null } : { status: "confirmed", amount: ukShipping },
    serviceFee: { status: "confirmed", amount: 15 },
    lookupMethod: product.source,
    warning: "Product price was found automatically, but some destination charges could not be calculated."
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/product") {
      if (request.method !== "GET") return jsonResponse({ success: false, error: "Method not allowed." }, 405);
      const productUrl = url.searchParams.get("url");
      if (productUrl) {
        try {
          const target = new URL(productUrl);
          if ((target.protocol === "http:" || target.protocol === "https:") && !isPrivateHostname(target.hostname)) {
            const result = await handleProduct(request, env, target);
            if (result) return result;
          }
        } catch {}
      }
      return callLegacy(request, env);
    }

    if (url.pathname === "/api/estimate") {
      if (request.method !== "GET") return jsonResponse({ success: false, error: "Method not allowed." }, 405);
      return callLegacy(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
