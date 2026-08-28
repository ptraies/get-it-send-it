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

async function fetchViaJina(productUrl, articleCode) {
  const started = Date.now();
  const readerUrl = `https://r.jina.ai/${productUrl}`;

  try {
    const response = await fetch(readerUrl, {
      headers: {
        "Accept": "text/plain, text/markdown, */*",
        "User-Agent": "GetItSendIt/1.4"
      },
      redirect: "follow",
      cache: "no-store"
    });

    const text = await response.text();
    const preview = text.slice(0, 12000);

    // Jina Reader returns a clean rendering of the page. Prefer a price close
    // to the exact H&M article number and reject unrelated prices.
    const articlePos = preview.indexOf(articleCode);
    const nearby = articlePos >= 0
      ? preview.slice(Math.max(0, articlePos - 1800), Math.min(preview.length, articlePos + 1800))
      : preview;

    const pricePatterns = [
      /(?:Price|Current price|Our price|Sale price)\s*[:\-]?\s*(?:£|GBP\s*)?([0-9]{1,6}(?:,[0-9]{3})?(?:\.[0-9]{2})?)/i,
      /£\s*([0-9]{1,6}(?:,[0-9]{3})?(?:\.[0-9]{2})?)/,
      /GBP\s*([0-9]{1,6}(?:,[0-9]{3})?(?:\.[0-9]{2})?)/i
    ];

    let price = null;
    for (const pattern of pricePatterns) {
      const match = nearby.match(pattern);
      if (match) {
        price = cleanPrice(match[1]);
        if (price !== null && price > 0 && price < 100000) break;
      }
    }

    const nameMatch = nearby.match(/^#\s+(.+)$/m) || nearby.match(/Art\. No\.?:?\s*`?${articleCode}`?/i);
    let name = null;
    if (nameMatch?.[1]) name = nameMatch[1].trim();

    // Stronger validation: the returned content must mention this exact
    // article code, otherwise a generic/search page is not accepted.
    const exactArticleFound = text.includes(articleCode);

    return {
      ok: response.ok && exactArticleFound && price !== null,
      status: response.status,
      ms: Date.now() - started,
      readerUrl,
      exactArticleFound,
      price,
      name,
      preview: preview.slice(0, 5000)
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      readerUrl,
      error: String(error?.message || error)
    };
  }
}

async function estimateFromWorker(request, env, product) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-hm-jina" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      if (!articleCode) return jsonResponse({ success: false, error: "Invalid H&M product URL." }, 400);
      return jsonResponse({ success: true, articleCode, jina: await fetchViaJina(productUrl, articleCode) });
    }

    if (url.pathname === "/api/product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const articleCode = productUrl ? getHMArticleCode(productUrl) : null;
      const destination = (url.searchParams.get("destination") || "").trim();

      if (productUrl && articleCode && destination) {
        const jina = await fetchViaJina(productUrl, articleCode);
        if (jina.ok) {
          const product = {
            articleCode,
            name: jina.name,
            price: jina.price,
            currency: "GBP",
            source: "jina_reader_hm"
          };

          const estimate = await estimateFromWorker(request, env, product);
          if (estimate) {
            return jsonResponse({
              ...estimate,
              success: true,
              product: {
                ...(estimate.product || {}),
                name: product.name || estimate.product?.name || null,
                price: product.price,
                currency: "GBP",
                priceGbp: product.price,
                availability: estimate.product?.availability || null
              },
              lookupMethod: product.source,
              articleCode,
              sourceUrl: productUrl
            });
          }

          return jsonResponse({
            success: true,
            product: {
              name: product.name,
              price: product.price,
              currency: "GBP",
              priceGbp: product.price,
              availability: null
            },
            lookupMethod: product.source,
            articleCode,
            sourceUrl: productUrl,
            warning: "The H&M price was found automatically, but the rest of the estimate could not be calculated."
          });
        }
      }
    }

    return currentWorker.fetch(request, env);
  }
};
