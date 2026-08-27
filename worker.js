const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const RULES_VERSION = "2026-08-27.1";
const SERVICE_FEE_GBP = 15;

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
  const normalized = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
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

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&pound;/gi, "£")
    .replace(/&#163;/gi, "£")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">" ).replace(/&nbsp;/gi, " ");
}

async function fetchText(url, accept = "text/html,application/xhtml+xml,application/json") {
  return fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.1; +https://getitsendit.co.uk)",
      Accept: accept
    },
    redirect: "follow"
  });
}

function extractJsonLd(html) {
  const values = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { values.push(JSON.parse(match[1].trim())); } catch {}
  }
  return values;
}

function findProductOffer(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductOffer(item);
      if (found) return found;
    }
    return null;
  }
  const type = Array.isArray(value["@type"]) ? value["@type"].map(String).join(" ") : String(value["@type"] || "");
  if (/product/i.test(type) && value.offers) {
    const offers = Array.isArray(value.offers) ? value.offers : [value.offers];
    for (const offer of offers) {
      if (!offer || typeof offer !== "object") continue;
      const price = cleanPrice(offer.price ?? offer.lowPrice);
      if (price !== null) return { name: value.name || null, price, currency: normaliseCurrency(offer.priceCurrency), availability: offer.availability || null, source: "json-ld" };
    }
  }
  for (const key of Object.keys(value)) {
    const found = findProductOffer(value[key]);
    if (found) return found;
  }
  return null;
}

function extractProductFromHtml(html) {
  for (const data of extractJsonLd(html)) {
    const found = findProductOffer(data);
    if (found) return found;
  }
  return null;
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
    const response = await fetchText(endpoint, "application/json,text/plain,*/*");
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return null;
    const data = await response.json();
    const variants = Array.isArray(data.variants) ? data.variants : [];
    const available = variants.find(v => v && v.available && cleanPrice(v.price) !== null);
    const variant = available || variants.find(v => cleanPrice(v?.price) !== null);
    let price = cleanPrice(data.price);
    if (price !== null && price > 10000) price /= 100;
    if (price === null && variant) {
      price = cleanPrice(variant.price);
      if (price !== null && price > 10000) price /= 100;
    }
    if (price === null && cleanPrice(data.price_min) !== null) {
      price = cleanPrice(data.price_min);
      if (price > 10000) price /= 100;
    }
    if (price === null) return null;
    return {
      name: data.title || null,
      price,
      currency: normaliseCurrency(data.currency) || "GBP",
      availability: data.available === false ? "OutOfStock" : (data.available === true ? "InStock" : null),
      source: "shopify-json",
      endpoint
    };
  } catch {
    return null;
  }
}

async function fetchRetailer(url) {
  try {
    const response = await fetchText(url);
    if (!response.ok) return { ok: false, status: response.status };
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return { ok: false, status: 422 };
    return { ok: true, html: await response.text(), finalUrl: response.url };
  } catch {
    return { ok: false, status: 0 };
  }
}

function extractShippingLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const text = stripHtml(decodeHtml(match[2]));
    if (!/(shipping|delivery|postage|dispatch)/i.test(text)) continue;
    try {
      const url = new URL(match[1], baseUrl);
      if (url.origin === new URL(baseUrl).origin) links.push(url.toString());
    } catch {}
  }
  return [...new Set(links)].slice(0, 4);
}

function parseShippingPolicy(text, productPrice) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (/(?:free|no\s+(?:cost|charge))\s+(?:standard\s+)?(?:uk|u\.k\.|united kingdom)?\s*(?:delivery|shipping|postage)/i.test(clean) && !/from\s+£?\s*\d/i.test(clean)) {
    return { status: "confirmed", amount: 0, basis: "Retailer policy states UK delivery is free." };
  }
  const thresholdPatterns = [
    /(?:free|£\s*0)\s+(?:standard\s+)?(?:uk|u\.k\.|united kingdom)?\s*(?:delivery|postage)\s+(?:on|for|over|orders?\s+over)\s*£?\s*([\d,.]+)/i,
    /(?:free|£\s*0)[^.]{0,120}(?:over|above|from|orders?\s+of)\s*£?\s*([\d,.]+)/i
  ];
  for (const pattern of thresholdPatterns) {
    const match = clean.match(pattern);
    const threshold = match ? cleanPrice(match[1]) : null;
    if (threshold !== null && productPrice !== null && productPrice >= threshold) return { status: "confirmed", amount: 0, basis: `Free UK delivery applies above £${threshold.toFixed(2)}.` };
  }
  const flatPatterns = [
    /(?:uk|u\.k\.|united kingdom)[^.]{0,120}(?:delivery|shipping|postage)[^£$€\d]{0,20}(?:£|GBP\s*)\s*([\d,.]+)/i,
    /(?:delivery|shipping|postage)[^.]{0,80}(?:£|GBP\s*)\s*([\d,.]+)[^.]{0,80}(?:uk|u\.k\.|united kingdom)/i,
    /(?:standard\s+)?(?:delivery|shipping|postage)[^£$€\d]{0,20}(?:£|GBP\s*)\s*([\d,.]+)/i
  ];
  for (const pattern of flatPatterns) {
    const match = clean.match(pattern);
    const amount = match ? cleanPrice(match[1]) : null;
    if (amount !== null && amount >= 0 && amount <= 100) return { status: "confirmed", amount, basis: "UK delivery charge found in retailer information." };
  }
  if (/shipping\s+(?:is\s+)?calculated\s+(?:at|during)\s+checkout|delivery\s+calculated\s+at\s+checkout|calculated\s+at\s+checkout/i.test(clean)) return { status: "unknown", amount: null, basis: "Retailer calculates delivery at checkout." };
  return null;
}

async function findUkShipping(html, finalUrl, productPrice) {
  if (!html || !finalUrl) return { status: "unknown", amount: null, basis: "Retailer page was not available to establish UK delivery." };
  const direct = parseShippingPolicy(stripHtml(html), productPrice);
  if (direct) return direct;
  for (const link of extractShippingLinks(html, finalUrl)) {
    const result = await fetchRetailer(link);
    if (!result.ok) continue;
    const policy = parseShippingPolicy(stripHtml(result.html), productPrice);
    if (policy) return { ...policy, source: link };
  }
  return { status: "unknown", amount: null, basis: "We could not establish a reliable UK delivery charge from retailer information." };
}

const SHIPPING_BY_COUNTRY = {
  US:{low:20,high:35}, CA:{low:22,high:38}, AU:{low:24,high:42}, NZ:{low:25,high:43}, JP:{low:22,high:38}, KR:{low:23,high:40}, SG:{low:23,high:40}, AE:{low:24,high:42}, IN:{low:22,high:40}, ZA:{low:25,high:45}, BR:{low:27,high:48}, AR:{low:29,high:50}, CL:{low:27,high:48}, IL:{low:24,high:42}, TR:{low:22,high:40}, NO:{low:20,high:35}, CH:{low:19,high:34}, IS:{low:22,high:38},
  DE:{low:15,high:25}, FR:{low:15,high:25}, ES:{low:16,high:27}, NL:{low:15,high:25}, BE:{low:15,high:25}, AT:{low:16,high:27}, IE:{low:16,high:27}, IT:{low:17,high:29}, PT:{low:18,high:30}, SE:{low:18,high:30}, DK:{low:18,high:30}, FI:{low:19,high:32}, PL:{low:17,high:29}, CZ:{low:17,high:29}, GR:{low:19,high:32}, HU:{low:18,high:30}, RO:{low:18,high:31}, HR:{low:18,high:31}
};

const SHIPPING_BY_REGION = {
  europe:{low:18,high:32}, northAmerica:{low:22,high:38}, centralAmerica:{low:25,high:45}, southAmerica:{low:27,high:50}, caribbean:{low:27,high:50}, middleEast:{low:24,high:44}, northAfrica:{low:24,high:44}, subSaharanAfrica:{low:27,high:50}, eastAsia:{low:23,high:42}, southAsia:{low:23,high:42}, southEastAsia:{low:24,high:44}, centralAsia:{low:25,high:46}, oceania:{low:24,high:44}, other:{low:28,high:55}
};

const COUNTRY_REGION = {};
for (const c of ["AL","AD","AT","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IE","IT","LV","LI","LT","LU","MT","MC","ME","NL","MK","NO","PL","PT","RO","SM","RS","SK","SI","ES","SE","CH","UA","VA"]) COUNTRY_REGION[c] = "europe";
for (const c of ["US","CA","MX"]) COUNTRY_REGION[c] = "northAmerica";
for (const c of ["BZ","CR","SV","GT","HN","NI","PA"]) COUNTRY_REGION[c] = "centralAmerica";
for (const c of ["AR","BO","BR","CL","CO","EC","GY","PY","PE","SR","UY","VE"]) COUNTRY_REGION[c] = "southAmerica";
for (const c of ["AG","BS","BB","CU","DM","DO","GD","HT","JM","KN","LC","VC","TT"]) COUNTRY_REGION[c] = "caribbean";
for (const c of ["AE","BH","IL","JO","KW","LB","OM","QA","SA","TR","YE"]) COUNTRY_REGION[c] = "middleEast";
for (const c of ["DZ","EG","LY","MA","TN"]) COUNTRY_REGION[c] = "northAfrica";
for (const c of ["ZA","NG","KE","GH","TZ","UG","ZM","ZW","BW","NA","MZ","MU","AO","BJ","BF","BI","CM","CV","CD","CG","CI","DJ","ER","ET","GA","GM","GN","GW","LR","LS","MG","MW","ML","MR","NE","RW","SC","SN","SL","SO","SS","SZ","TD","TG"]) COUNTRY_REGION[c] = "subSaharanAfrica";
for (const c of ["CN","HK","JP","KR","MN","TW"]) COUNTRY_REGION[c] = "eastAsia";
for (const c of ["AF","BD","BT","IN","MV","NP","PK","LK"]) COUNTRY_REGION[c] = "southAsia";
for (const c of ["BN","KH","ID","LA","MY","MM","PH","SG","TH","VN","TL"]) COUNTRY_REGION[c] = "southEastAsia";
for (const c of ["KZ","KG","TJ","TM","UZ"]) COUNTRY_REGION[c] = "centralAsia";
for (const c of ["AU","FJ","NZ","PG","WS","TO","VU","SB","KI","NR","PW","FM","MH","TV"]) COUNTRY_REGION[c] = "oceania";

function destinationEstimate(country) {
  if (SHIPPING_BY_COUNTRY[country]) return { status:"regional_planning_estimate", ...SHIPPING_BY_COUNTRY[country], scope:"country", country, basis:"Planning range based on destination country. It is not a carrier quote." };
  const region = COUNTRY_REGION[country] || "other";
  return { status:"regional_planning_estimate", ...SHIPPING_BY_REGION[region], scope:"regional", region, basis:`Regional planning range for ${region}. It is not a carrier quote and final price depends on parcel size, weight, dimensions, service level and carrier.` };
}

const IMPORT_TAX_RULES = {
  AU:{rate:.10,label:"GST"}, NZ:{rate:.15,label:"GST"}, DE:{rate:.19,label:"import VAT"}, FR:{rate:.20,label:"import VAT"}, ES:{rate:.21,label:"import VAT"}, NL:{rate:.21,label:"import VAT"}, IT:{rate:.22,label:"import VAT"}, BE:{rate:.21,label:"import VAT"}, AT:{rate:.20,label:"import VAT"}, IE:{rate:.23,label:"import VAT"}, PT:{rate:.23,label:"import VAT"}, SE:{rate:.25,label:"import VAT"}, DK:{rate:.25,label:"import VAT"}, FI:{rate:.255,label:"import VAT"}, PL:{rate:.23,label:"import VAT"}, CZ:{rate:.21,label:"import VAT"}, GR:{rate:.24,label:"import VAT"}, HU:{rate:.27,label:"import VAT"}, RO:{rate:.21,label:"import VAT"}, HR:{rate:.25,label:"import VAT"}
};

function indicativeImportTax(country, lowBase, highBase) {
  const rule = IMPORT_TAX_RULES[country];
  if (!rule || lowBase === null || highBase === null) return { status:"unknown", low:null, high:null, label:"Import taxes", basis:"We do not have enough verified information to calculate destination import charges safely." };
  return { status:"indicative", low:lowBase * rule.rate, high:highBase * rule.rate, label:rule.label, basis:`Indicative ${rule.rate * 100}% ${rule.label} calculation. Customs valuation, duty, exemptions and collection arrangements can change the actual amount.` };
}

function customsDutyEstimate() {
  return { status:"unknown", low:null, high:null, label:"Customs duty", basis:"Not included. A defensible duty calculation normally requires product classification, origin and destination-specific tariff information." };
}

async function convertToGbp(amount, currency) {
  const code = normaliseCurrency(currency);
  if (!code || code === "GBP") return { status:"confirmed", amount, currency:"GBP", basis:"Price already supplied in GBP." };
  try {
    const response = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(code)}/GBP`, { headers:{Accept:"application/json"} });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!Number.isFinite(data.rate) || data.rate <= 0) throw new Error();
    return { status:"estimated", amount:amount * data.rate, currency:"GBP", rate:data.rate, source:"Frankfurter/ECB reference-rate service", basis:"Converted using the latest available reference rate. The retailer, card provider or payment provider may use a different exchange rate or add a foreign-exchange fee." };
  } catch {
    return { status:"unknown", amount:null, currency:"GBP", basis:`We could not obtain a current ${code}/GBP reference rate.` };
  }
}

function calculateEstimate({ productGbp, ukShipping, destinationShipping, destination }) {
  const ukKnown = ukShipping?.status === "confirmed" && Number.isFinite(ukShipping.amount);
  const destinationKnown = destinationShipping && Number.isFinite(destinationShipping.low) && Number.isFinite(destinationShipping.high);
  const ukAmount = ukKnown ? ukShipping.amount : null;
  const baseLow = productGbp + SERVICE_FEE_GBP + (ukAmount ?? 0) + (destinationKnown ? destinationShipping.low : 0);
  const baseHigh = productGbp + SERVICE_FEE_GBP + (ukAmount ?? 0) + (destinationKnown ? destinationShipping.high : 0);
  const customsBaseLow = productGbp + (ukAmount ?? 0) + (destinationKnown ? destinationShipping.low : 0);
  const customsBaseHigh = productGbp + (ukAmount ?? 0) + (destinationKnown ? destinationShipping.high : 0);
  const importTax = indicativeImportTax(destination, customsBaseLow, customsBaseHigh);
  const unresolved = [];
  if (!ukKnown) unresolved.push("Retailer → UK delivery");
  if (!destinationKnown) unresolved.push("UK → destination shipping");
  if (importTax.status === "unknown") unresolved.push("Destination import taxes");
  unresolved.push("Customs duty");
  return {
    product:{status:"confirmed",amount:productGbp},
    ukShipping,
    destinationShipping,
    serviceFee:{status:"confirmed",amount:SERVICE_FEE_GBP},
    importTax,
    customsDuty:customsDutyEstimate(),
    total:{status:unresolved.length ? "partial" : "estimated",low:baseLow + (importTax.low ?? 0),high:baseHigh + (importTax.high ?? 0),currency:"GBP"},
    unresolved,
    vatWarning:"UK VAT treatment depends on the actual purchase/export arrangement. This estimate does not assume that UK VAT is automatically zero-rated.",
    rulesVersion:RULES_VERSION
  };
}

async function buildProductFromUrl(productUrl, destination) {
  let shopifyAttempted = false;
  let shopifyProduct = null;
  try {
    shopifyAttempted = Boolean(getShopifyProductUrl(productUrl));
    shopifyProduct = await fetchShopifyProduct(productUrl);
  } catch {}
  const page = await fetchRetailer(productUrl);
  let product = shopifyProduct;
  let pageError = null;
  if (!product && page.ok) product = extractProductFromHtml(page.html);
  if (!product) {
    if (!page.ok) pageError = page.status === 403 ? "The retailer is blocking automated access to this product page." : (page.status ? `The retailer returned HTTP ${page.status}.` : "We could not access the retailer page.");
    return { product:null, page, pageError, shopifyAttempted };
  }
  const ukShipping = page.ok ? await findUkShipping(page.html, page.finalUrl, product.price) : { status:"unknown", amount:null, basis:"Retailer page could not be accessed to establish UK delivery." };
  const fx = await convertToGbp(product.price, product.currency);
  if (fx.status === "unknown") return { product, page, pageError:fx.basis, ukShipping, fx };
  const destinationShipping = destinationEstimate(destination);
  return { product, page, pageError, ukShipping, fx, destinationShipping, estimate:calculateEstimate({productGbp:fx.amount,ukShipping,destinationShipping,destination}) };
}

async function handleProductRequest(url) {
  const productUrl = url.searchParams.get("url");
  const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();
  if (!productUrl) return jsonResponse({success:false,error:"Please provide a product URL."},400);
  if (!destination) return jsonResponse({success:false,error:"Please provide a destination country."},400);
  let target;
  try { target = new URL(productUrl); } catch { return jsonResponse({success:false,error:"That doesn't appear to be a valid URL."},400); }
  if (!ALLOWED_PROTOCOLS.has(target.protocol)) return jsonResponse({success:false,error:"Only web URLs are supported."},400);
  if (isPrivateHostname(target.hostname)) return jsonResponse({success:false,error:"That URL cannot be accessed."},400);
  const result = await buildProductFromUrl(target.toString(), destination);
  if (!result.product) {
    return jsonResponse({
      success:false,
      error:result.pageError || "We couldn't automatically find the product price.",
      needsManualPrice:true,
      diagnostics:{shopifyFallbackAttempted:result.shopifyAttempted, retailerStatus:result.page?.status || null},
      ukShipping:result.ukShipping || {status:"unknown",amount:null,basis:"UK delivery unavailable."},
      destinationShipping:destinationEstimate(destination),
      importTax:indicativeImportTax(destination,null,null),
      customsDuty:customsDutyEstimate(),
      serviceFee:{status:"confirmed",amount:SERVICE_FEE_GBP},
      rulesVersion:RULES_VERSION
    },502);
  }
  if (result.fx?.status === "unknown") return jsonResponse({success:false,error:result.fx.basis,needsManualPrice:true,product:{name:result.product.name,price:result.product.price,currency:result.product.currency,availability:result.product.availability},ukShipping:result.ukShipping,destinationShipping:destinationEstimate(destination),importTax:indicativeImportTax(destination,null,null),customsDuty:customsDutyEstimate(),serviceFee:{status:"confirmed",amount:SERVICE_FEE_GBP},rulesVersion:RULES_VERSION});
  return jsonResponse({success:true,product:{name:result.product.name,price:result.product.price,currency:result.product.currency,priceGbp:result.fx.amount,availability:result.product.availability},fx:result.fx,source:result.product.source,...result.estimate});
}

async function handleManualEstimate(url) {
  const productPrice = cleanPrice(url.searchParams.get("price"));
  const currency = normaliseCurrency(url.searchParams.get("currency") || "GBP");
  const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();
  const ukShippingRaw = cleanPrice(url.searchParams.get("ukShipping"));
  if (productPrice === null || productPrice < 0) return jsonResponse({success:false,error:"Please provide a valid product price."},400);
  if (!destination) return jsonResponse({success:false,error:"Please provide a destination country."},400);
  const fx = await convertToGbp(productPrice,currency);
  if (fx.status === "unknown") return jsonResponse({success:false,error:fx.basis,rulesVersion:RULES_VERSION},502);
  const ukShipping = ukShippingRaw !== null ? {status:"confirmed",amount:ukShippingRaw,basis:"UK delivery amount supplied by the customer."} : {status:"unknown",amount:null,basis:"UK delivery was not supplied and could not be established automatically."};
  const destinationShipping = destinationEstimate(destination);
  return jsonResponse({success:true,product:{name:null,price:productPrice,currency,priceGbp:fx.amount,availability:null},fx,...calculateEstimate({productGbp:fx.amount,ukShipping,destinationShipping,destination})});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/product") {
      if (request.method !== "GET") return jsonResponse({success:false,error:"Method not allowed."},405);
      return handleProductRequest(url);
    }
    if (url.pathname === "/api/estimate") {
      if (request.method !== "GET") return jsonResponse({success:false,error:"Method not allowed."},405);
      return handleManualEstimate(url);
    }
    return env.ASSETS.fetch(request);
  }
};
