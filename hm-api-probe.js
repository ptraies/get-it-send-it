function cleanPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^0-9.,-]/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned.replace(/,(?=\d{3}(?:\D|$))/g, ""));
  return Number.isFinite(n) ? n : null;
}

function walkForProduct(value, articleCode, seen = new Set()) {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walkForProduct(item, articleCode, seen);
      if (hit) return hit;
    }
    return null;
  }

  const values = Object.values(value);
  const joined = values.slice(0, 20).map(v => typeof v === "string" ? v : "").join(" ");
  const hasArticle = Object.entries(value).some(([k, v]) =>
    /article(code|_code|id)?|product(code|_code|id)?|sku/i.test(k) && String(v) === String(articleCode)
  ) || joined.includes(String(articleCode));

  if (hasArticle) {
    const priceKeys = ["price", "sellingPrice", "currentPrice", "listPrice", "originalPrice", "formattedPrice"];
    for (const key of priceKeys) {
      const price = cleanPrice(value[key]);
      if (price !== null && price > 0 && price < 100000) {
        return {
          objectKeys: Object.keys(value).slice(0, 80),
          price,
          name: value.name || value.title || value.productName || null,
          currency: value.currency || value.priceCurrency || value.currencyCode || "GBP",
          matchedKey: key,
          objectPreview: value
        };
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.length > 120) continue;
    const hit = walkForProduct(child, articleCode, seen);
    if (hit) return hit;
  }
  return null;
}

async function probe(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.4; +https://getitsendit.co.uk)",
        "Referer": "https://www2.hm.com/en_gb/"
      },
      redirect: "follow",
      cache: "no-store"
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      finalUrl: response.url,
      ms: Date.now() - started,
      preview: text.slice(0, 1600),
      product: json ? walkForProduct(json, "1337412001") : null
    };
  } catch (error) {
    return {
      url,
      status: null,
      ms: Date.now() - started,
      error: String(error?.message || error)
    };
  }
}

export async function runHmApiProbe(articleCode) {
  const base = String(articleCode || "");
  const baseProductCode = base.slice(0, 7);
  const urls = [
    `https://www2.hm.com/hmwebservices/service/product/gb/availability/${baseProductCode}.json`,
    `https://api.hm.com/search-services/v1/en_gb/listing/resultpage?query=${encodeURIComponent(base)}&page=1&pageSize=72`,
    `https://api.hm.com/search-services/v1/en_gb/listing/resultpage?q=${encodeURIComponent(base)}&page=1&pageSize=72`,
    `https://api.hm.com/search-services/v1/en_gb/listing/resultpage?searchTerm=${encodeURIComponent(base)}&page=1&pageSize=72`
  ];
  return Promise.all(urls.map(probe));
}
