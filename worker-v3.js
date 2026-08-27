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

function extractHMPrice(item) {
  const directCandidates = [
    item?.price,
    item?.sellingPrice,
    item?.currentPrice,
    item?.redPrice,
    item?.whitePrice
  ];

  const direct = directCandidates
    .map(cleanPrice)
    .find((value) => value !== null && value > 0);

  if (direct !== undefined) return direct;

  const prices = Array.isArray(item?.prices) ? item.prices : [];
  const structured = prices
    .map((entry) => ({
      type: String(entry?.priceType || entry?.price_type || "").toLowerCase(),
      value: cleanPrice(entry?.price)
    }))
    .filter((entry) => entry.value !== null && entry.value > 0);

  const preferred = structured.find((entry) => entry.type === "redprice") ||
    structured.find((entry) => entry.type === "whiteprice") ||
    structured[0];

  return preferred?.value ?? null;
}

function collectHMPriceCandidates(value, candidates = []) {
  if (!value || typeof value !== "object") return candidates;

  if (Array.isArray(value)) {
    for (const item of value) collectHMPriceCandidates(item, candidates);
    return candidates;
  }

  for (const [key, child] of Object.entries(value)) {
    const keyName = String(key).toLowerCase();
    if (
      /^(price|regularprice|sellingprice|currentprice|redprice|whiteprice|saleprice|minprice|maxprice|formattedprice)$/.test(keyName)
    ) {
      const price = cleanPrice(child);
      if (price !== null && price > 0 && price < 100000) candidates.push(price);
    }
    if (child && typeof child === "object") {
      collectHMPriceCandidates(child, candidates);
    }
  }

  return candidates;
}

function extractHMNextDataProduct(html, articleCode) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1].trim());
    const pageProps = data?.props?.pageProps;
    const productPageProps = pageProps?.productPageProps;
    const aemData = productPageProps?.aemData;
    const info = aemData?.productArticleDetails;
    if (!info || typeof info !== "object") return null;

    const variations = info?.variations && typeof info.variations === "object"
      ? info.variations
      : {};
    const variation =
      variations[articleCode] ||
      Object.values(variations).find((item) => item && typeof item === "object") ||
      null;

    const localCandidates = [
      ...collectHMPriceCandidates(variation, []),
      ...collectHMPriceCandidates(info, [])
    ];
    const price = localCandidates.find((value) => value > 0) ??
      collectHMPriceCandidates(productPageProps, []).find((value) => value > 0) ??
      null;

    if (price === null) return null;

    return {
      name: info.productName || productPageProps?.productName || null,
      price,
      currency: "GBP",
      availability: null,
      articleCode
    };
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
        "Accept-Language": "en-GB,en;q=0.9",
        "Referer": productUrl
      },
      redirect: "follow",
      cache: "no-store"
    });

    if (response.ok) {
      const data = await response.json();
      const products = Array.isArray(data?.products) ? data.products : [];

      const product = products.find((item) => {
        const code = String(
          item?.articleCode ??
          item?.article_code ??
          item?.productId ??
          item?.id ??
          ""
        );
        const pdp = String(
          item?.pdpUrl ??
          item?.productUrl ??
          item?.product_url ??
          item?.url ??
          item?.link ??
          ""
        );

        return (
          code === articleCode ||
          pdp.includes(`productpage.${articleCode}.html`)
        );
      });

      if (product) {
        const price = extractHMPrice(product);
        if (price !== null) {
          return {
            name: product.productName || product.name || product.title || null,
            price,
            currency: "GBP",
            availability:
              product?.availability?.stockState === "Unavailable" ||
              product?.availability?.stockState === "OutOfStock" ||
              product?.is_out_of_stock === true ||
              product?.outOfStock === true
                ? "OutOfStock"
                : "InStock",
            articleCode
          };
        }
      }
    }
  } catch {}

  // H&M also embeds the product page state in __NEXT_DATA__. The search
  // endpoint is useful when available, but the product page is a better
  // fallback for direct article-code URLs and survives changes to the
  // search response shape.
  try {
    const pageResponse = await fetch(productUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Referer": "https://www2.hm.com/en_gb/"
      },
      redirect: "follow",
      cache: "no-store"
    });

    if (pageResponse.ok) {
      const contentType = pageResponse.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        const html = await pageResponse.text();
        const product = extractHMNextDataProduct(html, articleCode);
        if (product) return product;
      }
    }
  } catch {}

  return null;
}

async function estimateForProduct(request, env, product) {
  const incoming = new URL(request.url);
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency);
  estimateUrl.searchParams.set(
    "destination",
    incoming.searchParams.get("destination") || ""
  );

  try {
    const response = await baseWorker.fetch(
      new Request(estimateUrl.toString(), { method: "GET" }),
      env
    );
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
