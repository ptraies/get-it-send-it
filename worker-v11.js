import currentWorker from "./worker-v10.js";

function jsonResponse(data, status = 200, headers = {}) {
  const clean = { ...headers };
  delete clean["content-length"];
  clean["content-type"] = "application/json; charset=UTF-8";
  clean["cache-control"] = "no-store";
  return new Response(JSON.stringify(data), { status, headers: clean });
}

function authHeader(apiKey) {
  const bytes = new TextEncoder().encode(`${apiKey}:`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function weightToKg(value, unit) {
  const n = finite(value);
  if (n === null) return null;
  const u = String(unit || "").toLowerCase();
  if (u.includes("kilogram") || u === "kg" || u === "kgs") return n;
  if (u.includes("gram") || u === "g") return n / 1000;
  if (u.includes("pound") || u === "lb" || u === "lbs") return n * 0.45359237;
  if (u.includes("ounce") || u === "oz") return n * 0.028349523125;
  return null;
}

function parseWeightString(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(kg|kgs|kilograms?|g|grams?|lb|lbs|pounds?|oz|ounces?)\b/i);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  const kg = weightToKg(amount, match[2]);
  if (kg === null || kg <= 0 || kg > 1000) return null;
  return { kg, raw: text, confidence: "extracted" };
}

function parseDimensionsString(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const unitMatch = text.match(/\b(mm|cm|m|in|inch|inches|ft|feet)\b/i);
  const values = [...text.matchAll(/([0-9]+(?:[.,][0-9]+)?)/g)].slice(0, 3).map(m => Number(m[1].replace(",", ".")));
  if (values.length !== 3) return null;
  const unit = String(unitMatch?.[1] || "").toLowerCase();
  let factor = null;
  if (unit === "mm") factor = 0.1;
  else if (unit === "cm") factor = 1;
  else if (unit === "m") factor = 100;
  else if (["in", "inch", "inches"].includes(unit)) factor = 2.54;
  else if (["ft", "feet"].includes(unit)) factor = 30.48;
  if (factor === null) return null;
  return { cm: values.map(v => v * factor), raw: text, confidence: "extracted" };
}

function extractExistingPhysicalData(product) {
  const weight = product?.weight;
  if (weight && finite(weight.value) !== null) {
    const kg = weightToKg(weight.value, weight.unit);
    if (kg !== null) return { weightKg: kg, weight: { value: Number(weight.value), unit: weight.unit || weight.rawUnit || null, raw: weight.rawUnit || null, confidence: "standard-zyte" } };
  }
  const additional = Array.isArray(product?.additionalProperties) ? product.additionalProperties : [];
  const foundWeight = additional.find(x => /weight/i.test(String(x?.name || "")));
  if (foundWeight) {
    const parsed = parseWeightString(foundWeight.value);
    if (parsed) return { weightKg: parsed.kg, weight: parsed };
  }
  return { weightKg: null, weight: null };
}

async function requestPhysicalData(env, productUrl, extractFrom) {
  if (!env?.ZYTE_API_KEY) return null;
  try {
    const body = {
      url: productUrl,
      product: true,
      productOptions: { extractFrom, ai: true },
      customAttributes: {
        physical_weight: {
          type: "string",
          description: "What product weight is explicitly stated on the product page or its specifications? Return the value and unit verbatim, such as 1.2 kg or 750 g. Do not estimate a weight."
        },
        product_dimensions: {
          type: "string",
          description: "What product dimensions are explicitly stated on the product page or its specifications? Return the dimensions and unit verbatim, such as 35 x 18 x 12 cm. Do not estimate dimensions."
        },
        package_weight: {
          type: "string",
          description: "What package/shipping weight is explicitly stated on the product page? Return the value and unit verbatim. Do not estimate a weight."
        },
        package_dimensions: {
          type: "string",
          description: "What package/shipping dimensions are explicitly stated on the product page? Return the dimensions and unit verbatim. Do not estimate dimensions."
        }
      },
      customAttributesOptions: { method: "extract" }
    };
    const response = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "Authorization": authHeader(env.ZYTE_API_KEY),
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) return null;
    const data = await response.json();
    const values = data?.customAttributes?.values || {};
    const weight = parseWeightString(values.package_weight) || parseWeightString(values.physical_weight);
    const dimensions = parseDimensionsString(values.package_dimensions) || parseDimensionsString(values.product_dimensions);
    if (!weight && !dimensions) return { source: `zyte_custom_${extractFrom}`, weight: null, dimensions: null };
    return { source: `zyte_custom_${extractFrom}`, weight, dimensions };
  } catch {
    return null;
  }
}

async function enrichPhysicalData(env, productUrl, data) {
  const existing = extractExistingPhysicalData(data?.product || {});
  if (existing.weightKg !== null) return { ...existing, dimensions: null, source: existing.weight?.confidence || "standard-zyte" };

  const http = await requestPhysicalData(env, productUrl, "httpResponseBody");
  if (http?.weight) return { weightKg: http.weight.kg, weight: http.weight, dimensions: http.dimensions, source: http.source };

  const browser = await requestPhysicalData(env, productUrl, "browserHtml");
  if (browser?.weight) return { weightKg: browser.weight.kg, weight: browser.weight, dimensions: browser.dimensions, source: browser.source };

  return { weightKg: null, weight: null, dimensions: http?.dimensions || browser?.dimensions || null, source: null };
}

function shippingProfile(weightKg, base) {
  const low = finite(base?.low);
  const high = finite(base?.high);
  if (low === null || high === null) return null;

  if (weightKg === null) {
    return {
      status: "planning_estimate",
      low,
      high,
      weightKnown: false,
      basis: `${base.basis || "Destination planning range."} Product weight was not available, so this remains a broad planning range.`
    };
  }

  if (weightKg > 20) {
    return {
      status: "specialist_quote",
      low: null,
      high: null,
      weightKnown: true,
      weightKg,
      basis: `Product weight extracted as approximately ${weightKg.toFixed(1)} kg. This is beyond our standard parcel planning bands, so specialist/heavy-freight pricing should be quoted rather than guessed.`
    };
  }

  let multiplier = 1;
  let band = "1–2 kg";
  if (weightKg <= 0.75) { multiplier = 0.78; band = "up to 0.75 kg"; }
  else if (weightKg <= 2) { multiplier = 1; band = "0.75–2 kg"; }
  else if (weightKg <= 5) { multiplier = 1.45; band = "2–5 kg"; }
  else if (weightKg <= 10) { multiplier = 2.1; band = "5–10 kg"; }
  else { multiplier = 3.0; band = "10–20 kg"; }

  return {
    status: "weight_aware_planning_estimate",
    low: Math.round(low * multiplier * 100) / 100,
    high: Math.round(high * multiplier * 100) / 100,
    weightKnown: true,
    weightKg,
    band,
    multiplier,
    basis: `Weight-aware planning range based on an extracted product weight of approximately ${weightKg.toFixed(2)} kg (${band}). Carrier, parcel dimensions, service level and final packaging can change the actual cost.`
  };
}

function recalculateTotal(data, shipping) {
  if (!shipping || shipping.low === null || shipping.high === null) return data;
  const product = finite(data.product?.priceGbp ?? data.product?.price);
  const uk = data.ukShipping?.status === "confirmed" ? (finite(data.ukShipping.amount) ?? 0) : 0;
  const fee = finite(data.serviceFee?.amount) ?? 15;
  if (product === null) return data;

  const profile = data.taxProfile;
  const minRate = finite(data.importTax?.rateMin) ?? (profile?.mode === "rate" ? finite(profile.minRate) : null);
  const maxRate = finite(data.importTax?.rateMax) ?? (profile?.mode === "rate" ? finite(profile.maxRate) : null);
  let importTax = data.importTax;
  let lowTax = 0;
  let highTax = 0;

  if (data.importTax?.status === "indicative" && minRate !== null && maxRate !== null) {
    lowTax = (product + uk + shipping.low) * minRate;
    highTax = (product + uk + shipping.high) * maxRate;
    importTax = { ...data.importTax, low: lowTax, high: highTax, basis: `${data.importTax.basis || ""} Shipping is weight-aware where a product weight could be extracted.` };
  }

  return {
    ...data,
    destinationShipping: shipping,
    importTax,
    total: {
      ...(data.total || {}),
      status: data.total?.status === "partial" ? "partial" : "estimated",
      low: product + uk + fee + shipping.low + lowTax,
      high: product + uk + fee + shipping.high + highTax,
      currency: "GBP"
    }
  };
}

function enrichApiResponse(response, productUrl, destination, env) {
  return response.text().then(async text => {
    let data;
    try { data = JSON.parse(text); } catch { return response; }
    if (!data?.success || !data?.product) return response;

    const physical = await enrichPhysicalData(env, productUrl, data);
    const shipping = shippingProfile(physical.weightKg, data.destinationShipping);
    const enriched = recalculateTotal({
      ...data,
      product: {
        ...data.product,
        physicalWeightKg: physical.weightKg,
        physicalWeight: physical.weight,
        physicalDimensions: physical.dimensions,
        physicalDataSource: physical.source
      },
      shippingInput: {
        weightKg: physical.weightKg,
        weight: physical.weight,
        dimensions: physical.dimensions,
        source: physical.source
      }
    }, shipping);

    if (shipping?.status === "specialist_quote") {
      enriched.total = { status: "partial", low: null, high: null, currency: "GBP" };
      enriched.warning = "This product is above our standard parcel planning range. Specialist/heavy-freight shipping should be quoted before purchase.";
    }
    return jsonResponse(enriched, response.status, Object.fromEntries(response.headers));
  });
}

function addShippingUi(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  return new HTMLRewriter().on("body", { element(element) {
    element.append(`<script>
      (() => {
        if (window.__gisV11ShippingUi) return;
        window.__gisV11ShippingUi = true;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const res = await originalFetch(...args);
          const url = String(args[0] || '');
          if (url.includes('/api/product')) {
            try {
              const clone = res.clone();
              const data = await clone.json();
              window.__gisShippingData = data;
              setTimeout(() => {
                const basis = document.getElementById('shippingBasis');
                const weight = data?.shippingInput?.weightKg;
                const specialist = data?.destinationShipping?.status === 'specialist_quote';
                if (basis) {
                  if (specialist) basis.textContent = 'Product weight is above our standard parcel range. Specialist/heavy-freight shipping requires a bespoke quote.';
                  else if (Number.isFinite(Number(weight))) basis.textContent = `Shipping estimate uses an extracted product weight of approximately ${Number(weight).toFixed(2)} kg. Final cost depends on packaging, dimensions, carrier and service level.`;
                  else basis.textContent = 'Product weight could not be established, so a broad destination planning range is shown. Final cost depends on package size, weight, dimensions, carrier and service level.';
                }
              }, 0);
            } catch {}
          }
          return res;
        };
      })();
    </script>`, {html:true});
  }}).transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/product" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      const destination = (url.searchParams.get("destination") || "").toUpperCase();
      const response = await currentWorker.fetch(request, env);
      if (!productUrl || !destination) return response;
      return enrichApiResponse(response, productUrl, destination, env);
    }
    const response = await currentWorker.fetch(request, env);
    if (url.pathname === "/" || url.pathname === "/index.html") return addShippingUi(response);
    return response;
  }
};
