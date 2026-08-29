import baseWorker from "./worker.js";

const MIN_SERVICE_FEE_GBP = 15;
const SERVICE_FEE_RATE = 0.15;
const VERSION = "2026-08-29.1";

const HM_HOSTS = new Set(["hm.com", "www.hm.com", "www2.hm.com"]);

const TAX_NEWS = [
  {
    country: "Worldwide",
    title: "Planning profiles expanded",
    summary: "Destination tax and import planning profiles continue to be reviewed and expanded.",
    date: "29 August 2026",
    status: "UPDATED",
    source: "PwC / official local-source review"
  },
  {
    country: "Papua New Guinea",
    title: "Import-tax planning profile reviewed",
    summary: "PNG GST planning treatment has been reviewed for customer estimates.",
    date: "29 August 2026",
    status: "UPDATED",
    source: "PwC / local-source review"
  }
];

const UPCOMING = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

function getQuantity(url) {
  const q = Math.floor(Number(url.searchParams.get("quantity") || 1));
  return Math.max(1, Math.min(99, Number.isFinite(q) ? q : 1));
}

function serviceFee(productPriceGbp, quantity = 1) {
  const totalProductValue = money(productPriceGbp * quantity);
  return money(Math.max(MIN_SERVICE_FEE_GBP, totalProductValue * SERVICE_FEE_RATE));
}

function parsePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const raw = value.replace(/[^0-9.,-]/g, "").trim();
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(/,(?=\d{3}(?:\D|$))/g, ""));
  return Number.isFinite(n) ? n : null;
}

function vatStatusFromText(text) {
  const s = String(text || "");
  if (/(including|inclusive of|incl\.?|inc\.?)[\s-]*(?:uk\s*)?vat\b|\bvat\s+(?:included|inclusive)\b/i.test(s)) {
    return { status: "included", basis: "The retailer indicates that the displayed product price includes VAT." };
  }
  if (/(excluding|exclusive of|ex\.?|exc\.?)[\s-]*(?:uk\s*)?vat\b|\bvat\s+(?:excluded|exclusive)\b|\bplus\s+vat\b/i.test(s)) {
    return { status: "excluded", basis: "The retailer indicates that the displayed product price excludes VAT." };
  }
  return { status: "unknown", basis: "We could not establish the VAT treatment from the retailer information available to us." };
}

function hmArticleCode(productUrl) {
  try {
    const u = new URL(productUrl);
    if (!HM_HOSTS.has(u.hostname.toLowerCase())) return null;
    const match = u.pathname.match(/\/productpage\.(\d+)\.html(?:$|\/)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function fixShopifySubunits(product) {
  if (!product) return null;
  const raw = parsePrice(product.price);
  if (raw === null || raw <= 0) return null;
  const price = raw / 100;
  if (!Number.isFinite(price) || price <= 0 || price >= 100000) return null;
  const text = `${product.title || ""} ${product.description || ""}`;
  return {
    name: product.title || product.name || null,
    price,
    currency: String(product.currency || "GBP").toUpperCase(),
    availability: product.available === false ? "OutOfStock" : product.available === true ? "InStock" : null,
    vatStatus: vatStatusFromText(product.taxes_included === true ? "price includes VAT" : text),
    source: "shopify_ajax"
  };
}

async function shopifyProduct(url) {
  let target;
  try { target = new URL(url); } catch { return null; }
  const match = target.pathname.match(/\/products\/([^/?#]+)/i);
  if (!match) return null;
  const endpoint = `${target.origin}/products/${encodeURIComponent(decodeURIComponent(match[1]))}.js`;
  try {
    const r = await fetch(endpoint, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.6; +https://getitsendit.co.uk)" }, cache: "no-store", redirect: "follow" });
    if (!r.ok) return null;
    return fixShopifySubunits(await r.json());
  } catch { return null; }
}

function extractStandardWeight(product) {
  const candidates = [product?.weight, product?.shippingWeight];
  for (const c of candidates) {
    if (c && num(c.value) !== null) {
      const amount = num(c.value);
      const unit = String(c.unit || c.rawUnit || "").toLowerCase();
      let kg = null;
      if (/^kg|kilogram/.test(unit)) kg = amount;
      else if (/^g$|gram/.test(unit)) kg = amount / 1000;
      else if (/lb|pound/.test(unit)) kg = amount * 0.45359237;
      else if (/oz|ounce/.test(unit)) kg = amount * 0.028349523125;
      if (kg && kg > 0 && kg < 1000) return { kg, raw: `${amount} ${c.unit || ""}`.trim(), source: "standard-zyte" };
    }
  }
  return null;
}

function parseWeight(value) {
  const s = String(value || "").trim();
  const m = s.match(/([0-9]+(?:[.,][0-9]+)?)\s*(kg|kgs|kilograms?|g|grams?|lb|lbs|pounds?|oz|ounces?)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  const u = m[2].toLowerCase();
  let kg = null;
  if (/^kg|kilogram/.test(u)) kg = n;
  else if (/^g$|gram/.test(u)) kg = n / 1000;
  else if (/lb|pound/.test(u)) kg = n * 0.45359237;
  else if (/oz|ounce/.test(u)) kg = n * 0.028349523125;
  return kg && kg > 0 && kg < 1000 ? { kg, raw: s, source: "zyte-custom" } : null;
}

async function zytePhysical(env, productUrl) {
  if (!env?.ZYTE_API_KEY) return null;
  const auth = `Basic ${btoa(`${env.ZYTE_API_KEY}:`)}`;
  const prompts = [
    "Return the product or package weight exactly as stated on the page, including unit. Do not estimate. If no weight is explicitly stated, return an empty string.",
    "Return the parcel/package dimensions exactly as stated on the page if explicitly stated. Do not estimate."
  ];
  try {
    const r = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        url: productUrl,
        product: true,
        productOptions: { extractFrom: "browserHtml", ai: true },
        customAttributes: {
          stated_weight: { type: "string", description: prompts[0] },
          stated_dimensions: { type: "string", description: prompts[1] }
        },
        customAttributesOptions: { method: "extract" }
      })
    });
    if (!r.ok) return null;
    const data = await r.json();
    const product = data?.product || {};
    const values = data?.customAttributes?.values || {};
    const weight = parseWeight(values.stated_weight) || parseWeight(product.weight);
    return { weight, rawWeight: values.stated_weight || null, dimensions: values.stated_dimensions || null, source: "zyte" };
  } catch {
    return null;
  }
}

function weightAwareShipping(base, weightKg, quantity) {
  if (!base || num(base.low) === null || num(base.high) === null) return base;
  if (weightKg === null) {
    return { ...base, weightKnown: false, quantity, basis: `${base.basis} Product weight was not available, so this remains a broad planning range.` };
  }
  const shipmentWeight = money(weightKg * quantity);
  if (shipmentWeight > 20) {
    return { ...base, low: null, high: null, weightKnown: true, shipmentWeightKg: shipmentWeight, quantity, status: "specialist_quote", basis: `Estimated shipment weight is approximately ${shipmentWeight.toFixed(2)} kg. We do not guess at heavy/specialist shipping.` };
  }
  let multiplier = 1;
  let band = "0.75–2 kg";
  if (shipmentWeight <= 0.75) { multiplier = 0.78; band = "up to 0.75 kg"; }
  else if (shipmentWeight <= 2) { multiplier = 1; band = "0.75–2 kg"; }
  else if (shipmentWeight <= 5) { multiplier = 1.45; band = "2–5 kg"; }
  else if (shipmentWeight <= 10) { multiplier = 2.1; band = "5–10 kg"; }
  else { multiplier = 3; band = "10–20 kg"; }
  return {
    ...base,
    low: money(base.low * multiplier),
    high: money(base.high * multiplier),
    weightKnown: true,
    shipmentWeightKg: shipmentWeight,
    quantity,
    weightBand: band,
    basis: `Weight-aware planning range based on an estimated shipment weight of approximately ${shipmentWeight.toFixed(2)} kg (${band}). Carrier, packaging, dimensions and service level can change the actual cost.`
  };
}

async function enrichEstimate(request, env, data, productUrl, quantity) {
  const unitPrice = num(data?.product?.priceGbp ?? data?.product?.price);
  if (unitPrice === null) return data;

  const physical = extractStandardWeight(data?.product) || await zytePhysical(env, productUrl);
  const weightKg = physical?.kg ?? physical?.weight?.kg ?? null;
  const shipping = weightAwareShipping(data.destinationShipping, weightKg, quantity);
  const fee = serviceFee(unitPrice, quantity);
  const productTotal = money(unitPrice * quantity);
  const uk = data.ukShipping?.status === "confirmed" ? (num(data.ukShipping.amount) || 0) : 0;

  let low = num(data.total?.low);
  let high = num(data.total?.high);
  let importTax = data.importTax;
  if (shipping?.low !== null && shipping?.high !== null) {
    const rMin = num(data.importTax?.rateMin);
    const rMax = num(data.importTax?.rateMax);
    if (data.importTax?.status === "indicative" && rMin !== null && rMax !== null) {
      const customsLow = productTotal + uk + shipping.low;
      const customsHigh = productTotal + uk + shipping.high;
      importTax = { ...data.importTax, low: money(customsLow * rMin), high: money(customsHigh * rMax) };
    }
    const taxLow = num(importTax?.low) || 0;
    const taxHigh = num(importTax?.high) || 0;
    low = money(productTotal + uk + fee + shipping.low + taxLow);
    high = money(productTotal + uk + fee + shipping.high + taxHigh);
  } else {
    low = null; high = null;
  }

  return {
    ...data,
    product: { ...data.product, unitPriceGbp: unitPrice, priceGbp: productTotal, price: productTotal, quantity, physicalWeightKg: weightKg, physicalWeight: physical?.raw || null, physicalDimensions: physical?.dimensions || null, physicalDataSource: physical?.source || null },
    quantity,
    serviceFee: { status: "confirmed", amount: fee, rate: SERVICE_FEE_RATE, minimum: MIN_SERVICE_FEE_GBP, basis: "The greater of £15 or 15% of the product price. Shipping and destination taxes are not included in this calculation." },
    destinationShipping: shipping,
    importTax,
    total: { ...(data.total || {}), status: shipping?.status === "specialist_quote" ? "partial" : "estimated", low, high, currency: "GBP", quantity },
    confidence: weightKg !== null && shipping?.status !== "specialist_quote" ? "Medium" : "Planning estimate",
    quoteContext: { productUrl, quantity, unitPriceGbp: unitPrice, productTotalGbp: productTotal, shipmentWeightKg: weightKg === null ? null : money(weightKg * quantity) },
    rulesVersion: VERSION
  };
}

async function productApi(request, env, url) {
  const productUrl = url.searchParams.get("url");
  const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();
  if (!productUrl || !destination) return baseWorker.fetch(request, env);
  const quantity = getQuantity(url);

  const shop = await shopifyProduct(productUrl);
  if (shop) {
    const internal = new URL("https://internal.local/api/estimate");
    internal.searchParams.set("price", String(shop.price));
    internal.searchParams.set("currency", shop.currency || "GBP");
    internal.searchParams.set("destination", destination);
    const r = await baseWorker.fetch(new Request(internal.toString(), { method: "GET" }), env);
    const data = await r.json();
    return json(await enrichEstimate(request, env, { ...data, product: { ...(data.product || {}), name: shop.name, price: shop.price, priceGbp: shop.price, currency: shop.currency, availability: shop.availability, vatStatus: shop.vatStatus }, vatStatus: shop.vatStatus }, productUrl, quantity));
  }

  const r = await baseWorker.fetch(request, env);
  let data = null; try { data = await r.clone().json(); } catch {}
  if (!data?.success) return r;
  if (data?.product?.priceGbp != null) return json(await enrichEstimate(request, env, data, productUrl, quantity), r.status);
  return r;
}

async function quoteApi(request, url) {
  if (request.method !== "POST") return json({ success: false, error: "Method not allowed." }, 405);
  let body = {};
  try { body = await request.json(); } catch { return json({ success: false, error: "Invalid request." }, 400); }
  const required = ["name", "email", "productUrl", "destination", "quantity"];
  if (required.some(k => !body[k])) return json({ success: false, error: "Please complete the required fields." }, 400);
  return json({ success: false, configured: false, message: "The quote request form is ready, but quote submission has not yet been connected to a mailbox or CRM." }, 501);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/product" && request.method === "GET") return productApi(request, env, url);
    if (url.pathname === "/api/tax-news" && request.method === "GET") return json({ success: true, updatedAt: "29 August 2026", liveStatus: "No new updates today", upcoming: UPCOMING, recent: TAX_NEWS, sourcePolicy: "Tax profiles are reviewed against official government/customs information, supported by established tax references such as PwC.", rulesVersion: VERSION });
    if (url.pathname === "/api/quote") return quoteApi(request, url);
    if (url.pathname === "/api/health" && request.method === "GET") return json({ success: true, version: VERSION });
    return baseWorker.fetch(request, env);
  }
};