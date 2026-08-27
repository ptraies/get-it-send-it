import legacyWorker from "./worker.js";

const SHOPIFY_USER_AGENT =
  "Mozilla/5.0 (compatible; GetItSendIt/1.3; +https://getitsendit.co.uk)";

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

function getShopifyProductUrl(productUrl) {
  const url = new URL(productUrl);
  const marker = "/products/";
  const index = url.pathname.toLowerCase().indexOf(marker);
  if (index < 0) return null;

  const prefix = url.pathname.slice(0, index);
  const remainder = url.pathname.slice(index + marker.length);
  const handle = remainder.split("/")[0];
  if (!handle) return null;

  return `${url.origin}${prefix}/products/${encodeURIComponent(decodeURIComponent(handle))}.js`;
}

function shopifyMoneyToMajorUnit(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value / 100;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number / 100;
  }
  return null;
}

async function fetchShopifyProduct(productUrl) {
  let endpoint;
  try {
    endpoint = getShopifyProductUrl(productUrl);
  } catch {
    return null;
  }
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

    // Do not trust the retailer's Content-Type header. Shopify product.js
    // endpoints can be served with a non-JSON media type while containing
    // perfectly valid JSON. Read the body and parse it ourselves.
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }

    const variants = Array.isArray(data.variants) ? data.variants : [];
    const available = variants.find(
      variant => variant && variant.available && shopifyMoneyToMajorUnit(variant.price) !== null
    );
    const variant = available || variants.find(item => shopifyMoneyToMajorUnit(item?.price) !== null);

    const priceValue = data.price ?? data.price_min ?? variant?.price;
    const price = shopifyMoneyToMajorUnit(priceValue);
    if (price === null) return null;

    return {
      name: data.title || null,
      price,
      currency: normaliseCurrency(data.currency) || "GBP",
      availability:
        data.available === false ? "OutOfStock" :
        data.available === true ? "InStock" : null,
      source: "shopify_ajax"
    };
  } catch {
    return null;
  }
}

async function callLegacy(request, env) {
  try {
    return await legacyWorker.fetch(request, env);
  } catch {
    return null;
  }
}

async function readJson(response) {
  if (!response) return null;
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function withShopifyProduct(data, product) {
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
    lookupMethod: "shopify_ajax"
  };
}

async function handleShopifyProductRequest(request, env, target) {
  const shopifyProduct = await fetchShopifyProduct(target.toString());
  if (!shopifyProduct) return null;

  // The legacy worker can still discover an exact retailer-to-UK delivery
  // charge. Failure here must never invalidate the verified Shopify price.
  let ukShipping = null;
  const legacyResponse = await callLegacy(request, env);
  const legacyData = await readJson(legacyResponse);

  if (legacyData?.ukShipping?.status === "confirmed" && Number.isFinite(legacyData.ukShipping.amount)) {
    ukShipping = legacyData.ukShipping.amount;
  }

  // Reuse the established estimate engine for destination shipping, import
  // tax and the £15 service fee. This endpoint does not perform product lookup.
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(shopifyProduct.price));
  estimateUrl.searchParams.set("currency", shopifyProduct.currency);
  estimateUrl.searchParams.set(
    "destination",
    new URL(request.url).searchParams.get("destination") || ""
  );
  if (ukShipping !== null) estimateUrl.searchParams.set("ukShipping", String(ukShipping));

  const estimateResponse = await callLegacy(new Request(estimateUrl.toString(), { method: "GET" }), env);
  const estimateData = await readJson(estimateResponse);

  if (estimateData?.success) {
    return jsonResponse(withShopifyProduct(estimateData, shopifyProduct));
  }

  return jsonResponse({
    success: true,
    product: {
      name: shopifyProduct.name,
      price: shopifyProduct.price,
      currency: shopifyProduct.currency,
      priceGbp: shopifyProduct.currency === "GBP" ? shopifyProduct.price : null,
      availability: shopifyProduct.availability
    },
    ukShipping: ukShipping === null
      ? {
          status: "unknown",
          amount: null,
          basis: "The product price was confirmed by Shopify, but UK delivery could not be established automatically."
        }
      : {
          status: "confirmed",
          amount: ukShipping,
          basis: "UK delivery was established from the retailer page."
        },
    serviceFee: { status: "confirmed", amount: 15 },
    lookupMethod: "shopify_ajax",
    warning: "Product price confirmed by Shopify. Destination charges could not be calculated by the existing estimate engine."
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
          if (
            (target.protocol === "http:" || target.protocol === "https:") &&
            !isPrivateHostname(target.hostname) &&
            /\/products\//i.test(target.pathname)
          ) {
            const shopifyResponse = await handleShopifyProductRequest(request, env, target);
            if (shopifyResponse) return shopifyResponse;
          }
        } catch {
          // Fall through to the established legacy validation and lookup path.
        }
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
