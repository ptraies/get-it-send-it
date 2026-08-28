import baseWorker from "./worker-v2.js";

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
  const n = Number.parseFloat(cleaned.replace(/,(?=\d{3}(?:\D|$))/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function browserHMProduct(env, productUrl, articleCode) {
  if (!env?.BROWSER?.quickAction) return null;

  try {
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

    const data = await response.clone().json();
    const result = data?.result || data?.data || null;
    const price = cleanPrice(result?.price);
    if (price === null || price <= 0 || price >= 100000) return null;

    return {
      name: result?.name || null,
      price,
      currency: String(result?.currency || "GBP").toUpperCase(),
      availability: result?.availability || null,
      articleCode,
      source: "cloudflare_browser_json"
    };
  } catch {
    return null;
  }
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

    if (url.pathname === "/api/product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;

      if (productUrl && articleCode) {
        // H&M is a JavaScript-heavy site. Use Cloudflare's managed browser
        // and structured extraction first; this is deliberately separate from
        // the older HTML/API heuristics because those repeatedly failed.
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

        // Keep the previous H&M implementation as a fallback. If Browser Run
        // is unavailable or H&M changes its rendered page, the site still has
        // the older extraction paths to try.
        return baseWorker.fetch(request, env);
      }
    }

    return baseWorker.fetch(request, env);
  }
};
