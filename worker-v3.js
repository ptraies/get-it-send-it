import baseWorker from "./worker-v2.js";

const H_M_HOSTS = new Set(["hm.com", "www.hm.com", "www2.hm.com"]);

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

function cleanPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^0-9.,-]/g, "").trim();
  if (!cleaned) return null;
  const number = Number.parseFloat(cleaned.replace(/,(?=\d{3}(?:\D|$))/g, ""));
  return Number.isFinite(number) ? number : null;
}

function getHMArticleCode(value) {
  try {
    const url = new URL(value);
    if (!H_M_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/\/productpage\.(\d+)\.html(?:$|\/)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function findHMProduct(productUrl) {
  const articleCode = getHMArticleCode(productUrl);
  if (!articleCode) return null;

  const endpoint = `https://www2.hm.com/en_gb/search-results/_jcr_content/search.display.json?q=${encodeURIComponent(articleCode)}&offset=0&page-size=10`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": productUrl
      },
      redirect: "follow",
      cache: "no-store"
    });

    if (!response.ok) return null;
    const data = await response.json();
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    const hit = hits.find((item) => {
      const code = String(item?.articleCode ?? item?.article_code ?? item?.productId ?? "");
      const pdp = String(item?.pdpUrl ?? item?.url ?? item?.link ?? "");
      return code === articleCode || pdp.includes(`productpage.${articleCode}.html`);
    });

    if (!hit) return null;

    const candidates = [
      hit.sellingPrice,
      hit.price,
      hit.currentPrice,
      hit.redPrice,
      hit.whitePrice
    ];
    const price = candidates.map(cleanPrice).find((value) => value !== null && value > 0);
    if (price === undefined) return null;

    return {
      name: hit.name || hit.productName || null,
      price,
      currency: "GBP",
      availability: hit.outOfStock === true ? "OutOfStock" : "InStock",
      articleCode
    };
  } catch {
    return null;
  }
}

async function estimateForProduct(request, env, product) {
  const incoming = new URL(request.url);
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency);
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
        currency: product.currency,
        priceGbp: product.price,
        availability: product.availability
      },
      lookupMethod: "hm_search_api",
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
      const product = productUrl ? await findHMProduct(productUrl) : null;

      if (product) {
        const estimate = await estimateForProduct(request, env, product);
        if (estimate) return jsonResponse(estimate);

        return jsonResponse({
          success: true,
          product: {
            name: product.name,
            price: product.price,
            currency: product.currency,
            priceGbp: product.price,
            availability: product.availability
          },
          lookupMethod: "hm_search_api",
          articleCode: product.articleCode,
          serviceFee: { status: "confirmed", amount: 15 },
          warning: "H&M product price was found automatically, but the full delivery estimate could not be calculated."
        });
      }
    }

    return baseWorker.fetch(request, env);
  }
};
