import legacyWorker from "./worker.js";

const SHOPIFY_USER_AGENT =
  "Mozilla/5.0 (compatible; GetItSendIt/1.2; +https://getitsendit.co.uk)";

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

  const aliases = {
    "£": "GBP",
    "$": "USD",
    "€": "EUR"
  };

  return aliases[value] || value;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }

  const parts = host.split(".").map(Number);

  if (
    parts.length === 4 &&
    parts.every(
      (part) =>
        Number.isInteger(part) &&
        part >= 0 &&
        part <= 255
    )
  ) {
    const [a, b] = parts;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
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

  return `${url.origin}${prefix}/products/${encodeURIComponent(
    decodeURIComponent(handle)
  )}.js`;
}

function shopifyMoneyToMajorUnit(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value / 100;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);

    if (Number.isFinite(number)) {
      return number / 100;
    }
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
        Accept: "application/json,text/plain,*/*"
      },
      redirect: "follow"
    });

    if (!response.ok) return null;

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.includes("json")) return null;

    const data = await response.json();
    const variants = Array.isArray(data.variants)
      ? data.variants
      : [];

    const available = variants.find(
      (variant) =>
        variant &&
        variant.available &&
        shopifyMoneyToMajorUnit(variant.price) !== null
    );

    const variant =
      available ||
      variants.find(
        (item) => shopifyMoneyToMajorUnit(item?.price) !== null
      );

    const priceValue =
      data.price ??
      data.price_min ??
      variant?.price;

    const price = shopifyMoneyToMajorUnit(priceValue);

    if (price === null) return null;

    return {
      name: data.title || null,
      price,
      currency: normaliseCurrency(data.currency) || "GBP",
      availability:
        data.available === false
          ? "OutOfStock"
          : data.available === true
            ? "InStock"
            : null,
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
      priceGbp:
        product.currency === "GBP"
          ? product.price
          : data?.product?.priceGbp,
      availability: product.availability
    },
    lookupMethod: "shopify_ajax"
  };
}

async function handleShopifyProductRequest(request, env, target) {
  const shopifyProduct = await fetchShopifyProduct(target.toString());

  if (!shopifyProduct) return null;

  // Let the existing worker try to obtain the retailer's exact UK shipping.
  // This is deliberately optional: a blocked product page must not prevent
  // a successful Shopify price lookup.
  const legacyResponse = await callLegacy(request, env);
  const legacyData = await readJson(legacyResponse);

  let ukShipping = null;

  if (
    legacyData?.ukShipping?.status === "confirmed" &&
    Number.isFinite(legacyData.ukShipping.amount)
  ) {
    ukShipping = legacyData.ukShipping.amount;
  }

  // Reuse the established calculation engine for destination shipping,
  // indicative import tax and the £15 service fee, but feed it the verified
  // Shopify price rather than whatever the retailer HTML happened to expose.
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(shopifyProduct.price));
  estimateUrl.searchParams.set("currency", shopifyProduct.currency);
  estimateUrl.searchParams.set(
    "destination",
    new URL(request.url).searchParams.get("destination") || ""
  );

  if (ukShipping !== null) {
    estimateUrl.searchParams.set("ukShipping", String(ukShipping));
  }

  const estimateRequest = new Request(estimateUrl.toString(), {
    method: "GET"
  });

  const estimateResponse = await callLegacy(
    estimateRequest,
    env
  );
  const estimateData = await readJson(estimateResponse);

  if (estimateData?.success) {
    return jsonResponse(
      withShopifyProduct(estimateData, shopifyProduct),
      200
    );
  }

  // The price is still useful even if the legacy calculation path fails.
  // Return a clear partial response rather than forcing manual entry.
  return jsonResponse(
    {
      success: true,
      product: {
        name: shopifyProduct.name,
        price: shopifyProduct.price,
        currency: shopifyProduct.currency,
        priceGbp:
          shopifyProduct.currency === "GBP"
            ? shopifyProduct.price
            : null,
        availability: shopifyProduct.availability
      },
      ukShipping:
        ukShipping === null
          ? {
              status: "unknown",
              amount: null,
              basis:
                "The product price was confirmed by Shopify, but UK delivery could not be established automatically."
            }
          : {
              status: "confirmed",
              amount: ukShipping,
              basis:
                "UK delivery was established from the retailer page."
            },
      serviceFee: {
        status: "confirmed",
        amount: 15
      },
      lookupMethod: "shopify_ajax",
      warning:
        "Product price confirmed by Shopify. Destination charges could not be calculated by the existing estimate engine."
    },
    200
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/product") {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            success: false,
            error: "Method not allowed."
          },
          405
        );
      }

      const productUrl = url.searchParams.get("url");

      if (productUrl) {
        try {
          const target = new URL(productUrl);

          if (
            (target.protocol === "http:" ||
              target.protocol === "https:") &&
            !isPrivateHostname(target.hostname) &&
            /\/products\//i.test(target.pathname)
          ) {
            const shopifyResponse =
              await handleShopifyProductRequest(
                request,
                env,
                target
              );

            if (shopifyResponse) {
              return shopifyResponse;
            }
          }
        } catch {
          // Fall through to the established worker validation and lookup path.
        }
      }

      return callLegacy(request, env);
    }

    if (url.pathname === "/api/estimate") {
      return callLegacy(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
