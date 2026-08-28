const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const RULES_VERSION = "2026-08-28.1";
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

function cleanPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") return null;

  const cleaned = value
    .replace(/[^0-9.,-]/g, "")
    .trim();

  if (!cleaned) return null;

  const normalized = cleaned.replace(
    /,(?=\d{3}(?:\D|$))/g,
    ""
  );

  const number = Number.parseFloat(normalized);

  return Number.isFinite(number) ? number : null;
}

function normaliseCurrency(currency) {
  if (!currency) return null;

  const value = String(currency)
    .toUpperCase()
    .trim();

  const aliases = {
    "£": "GBP",
    "$": "USD",
    "€": "EUR"
  };

  return aliases[value] || value;
}

function findProductOffer(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findProductOffer(item);

      if (result) {
        return result;
      }
    }

    return null;
  }

  const type = Array.isArray(value["@type"])
    ? value["@type"].map(String).join(" ")
    : String(value["@type"] || "");

  if (/product/i.test(type) && value.offers) {
    const offers = Array.isArray(value.offers)
      ? value.offers
      : [value.offers];

    for (const offer of offers) {
      if (!offer || typeof offer !== "object") {
        continue;
      }

      const price = cleanPrice(offer.price);

      if (price !== null) {
        return {
          name: value.name || null,
          price,
          currency: normaliseCurrency(
            offer.priceCurrency
          ),
          availability: offer.availability || null
        };
      }
    }
  }

  for (const key of Object.keys(value)) {
    const result = findProductOffer(value[key]);

    if (result) {
      return result;
    }
  }

  return null;
}

function extractJsonLd(html) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  const values = [];

  for (const match of scripts) {
    try {
      values.push(JSON.parse(match[1].trim()));
    } catch {
      // Ignore malformed JSON-LD and continue.
    }
  }

  return values;
}

function extractProductFromHtml(html) {
  for (const data of extractJsonLd(html)) {
    const result = findProductOffer(data);

    if (result) {
      return result;
    }
  }

  return null;
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
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
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

  try {
    endpoint = getShopifyProductUrl(productUrl);
  } catch {
    return null;
  }

  if (!endpoint) return null;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GetItSendIt/1.1; +https://getitsendit.co.uk)",
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
        cleanPrice(variant.price) !== null
    );

    const variant =
      available ||
      variants.find(
        (item) => cleanPrice(item?.price) !== null
      );

    let price = cleanPrice(data.price);

    if (price !== null && price > 10000) {
      price /= 100;
    }

    if (price === null && variant) {
      price = cleanPrice(variant.price);

      if (price !== null && price > 10000) {
        price /= 100;
      }
    }

    if (price === null && cleanPrice(data.price_min) !== null) {
      price = cleanPrice(data.price_min);

      if (price > 10000) {
        price /= 100;
      }
    }

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
            : null
    };
  } catch {
    return null;
  }
}

async function fetchRetailer(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; GetItSendIt/1.0; +https://getitsendit.co.uk)",
      Accept:
        "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status
    };
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    return {
      ok: false,
      status: 422
    };
  }

  return {
    ok: true,
    html: await response.text(),
    finalUrl: response.url
  };
}

function extractShippingLinks(html, baseUrl) {
  const links = [];

  const re =
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(re)) {
    const text = stripHtml(
      decodeHtml(match[2])
    );

    if (
      !/(shipping|delivery|postage|dispatch)/i.test(
        text
      )
    ) {
      continue;
    }

    try {
      const url = new URL(
        match[1],
        baseUrl
      );

      if (
        url.origin ===
        new URL(baseUrl).origin
      ) {
        links.push(url.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  }

  return [...new Set(links)].slice(0, 4);
}

function parseShippingPolicy(text, productPrice) {
  const clean = text
    .replace(/\s+/g, " ")
    .trim();

  const free =
    /(?:free|no\s+(?:cost|charge))\s+(?:standard\s+)?(?:uk|u\.k\.|united kingdom)?\s*(?:delivery|shipping|postage)/i.test(
      clean
    );

  if (
    free &&
    !/from\s+£?\s*\d/i.test(clean)
  ) {
    return {
      status: "confirmed",
      amount: 0,
      basis:
        "Retailer policy states UK delivery is free."
    };
  }

  const thresholdPatterns = [
    /(?:free|£\s*0)\s+(?:standard\s+)?(?:uk|u\.k\.|united kingdom)?\s*(?:delivery|postage)\s+(?:on|for|over|orders?\s+over)\s*£?\s*([\d,.]+)/i,

    /(?:free|£\s*0)[^\.]{0,120}(?:over|above|from|orders?\s+of)\s*£?\s*([\d,.]+)/i,

    /(?:£\s*([\d,.]+))[^\.]{0,100}(?:delivery|shipping|postage)[^\.]{0,100}(?:under|below|orders?\s+under)\s*£?\s*([\d,.]+)/i
  ];

  for (const pattern of thresholdPatterns) {
    const match = clean.match(pattern);

    if (!match) {
      continue;
    }

    const numbers = match
      .slice(1)
      .map(cleanPrice)
      .filter((value) => value !== null);

    if (
      numbers.length === 1 &&
      productPrice !== null
    ) {
      const threshold = numbers[0];

      if (productPrice >= threshold) {
        return {
          status: "confirmed",
          amount: 0,
          basis:
            `Free UK delivery applies above £${threshold.toFixed(2)}.`
        };
      }
    }
  }

  const flatPatterns = [
    /(?:uk|u\.k\.|united kingdom)[^\.]{0,120}(?:delivery|shipping|postage)[^£$€\d]{0,20}(?:£|GBP\s*)\s*([\d,.]+)/i,

    /(?:delivery|shipping|postage)[^\.]{0,80}(?:£|GBP\s*)\s*([\d,.]+)[^\.]{0,80}(?:uk|u\.k\.|united kingdom)/i,

    /(?:standard\s+)?(?:delivery|shipping|postage)[^£$€\d]{0,20}(?:£|GBP\s*)\s*([\d,.]+)/i
  ];

  for (const pattern of flatPatterns) {
    const match = clean.match(pattern);

    if (!match) {
      continue;
    }

    const amount = cleanPrice(match[1]);

    if (
      amount !== null &&
      amount >= 0 &&
      amount <= 100
    ) {
      return {
        status: "confirmed",
        amount,
        basis:
          "UK delivery charge found in retailer information."
      };
    }
  }

  if (
    /shipping\s+(?:is\s+)?calculated\s+(?:at|during)\s+checkout|delivery\s+calculated\s+at\s+checkout|calculated\s+at\s+checkout/i.test(
      clean
    )
  ) {
    return {
      status: "unknown",
      amount: null,
      basis:
        "Retailer calculates delivery at checkout."
    };
  }

  return null;
}

async function findUkShipping(
  html,
  finalUrl,
  productPrice
) {
  const productText = stripHtml(html);

  const direct = parseShippingPolicy(
    productText,
    productPrice
  );

  if (direct) {
    return direct;
  }

  const links = extractShippingLinks(
    html,
    finalUrl
  );

  for (const link of links) {
    try {
      const result = await fetchRetailer(link);

      if (!result.ok) {
        continue;
      }

      const policy = parseShippingPolicy(
        stripHtml(result.html),
        productPrice
      );

      if (policy) {
        return {
          ...policy,
          source: link
        };
      }
    } catch {
      // Try the next shipping-policy page.
    }
  }

  return {
    status: "unknown",
    amount: null,
    basis:
      "We could not establish a reliable UK delivery charge from the retailer information we could access."
  };
}

const SHIPPING_BY_COUNTRY = {
  US: { low: 20, high: 35 },
  CA: { low: 22, high: 38 },
  AU: { low: 24, high: 42 },
  NZ: { low: 25, high: 43 },
  JP: { low: 22, high: 38 },
  KR: { low: 23, high: 40 },
  SG: { low: 23, high: 40 },
  AE: { low: 24, high: 42 },
  IN: { low: 22, high: 40 },
  ZA: { low: 25, high: 45 },
  BR: { low: 27, high: 48 },
  AR: { low: 29, high: 50 },
  CL: { low: 27, high: 48 },
  IL: { low: 24, high: 42 },
  TR: { low: 22, high: 40 },
  NO: { low: 20, high: 35 },
  CH: { low: 19, high: 34 },
  IS: { low: 22, high: 38 },

  DE: { low: 15, high: 25 },
  FR: { low: 15, high: 25 },
  ES: { low: 16, high: 27 },
  NL: { low: 15, high: 25 },
  BE: { low: 15, high: 25 },
  AT: { low: 16, high: 27 },
  IE: { low: 16, high: 27 },
  IT: { low: 17, high: 29 },
  PT: { low: 18, high: 30 },
  SE: { low: 18, high: 30 },
  DK: { low: 18, high: 30 },
  FI: { low: 19, high: 32 },
  PL: { low: 17, high: 29 },
  CZ: { low: 17, high: 29 },
  GR: { low: 19, high: 32 },
  HU: { low: 18, high: 30 },
  RO: { low: 18, high: 31 },
  HR: { low: 18, high: 31 }
};

const SHIPPING_BY_REGION = {
  europe: { low: 18, high: 32 },
  northAmerica: { low: 22, high: 38 },
  centralAmerica: { low: 25, high: 45 },
  southAmerica: { low: 27, high: 50 },
  caribbean: { low: 27, high: 50 },
  middleEast: { low: 24, high: 44 },
  northAfrica: { low: 24, high: 44 },
  subSaharanAfrica: { low: 27, high: 50 },
  eastAsia: { low: 23, high: 42 },
  southAsia: { low: 23, high: 42 },
  southEastAsia: { low: 24, high: 44 },
  centralAsia: { low: 25, high: 46 },
  oceania: { low: 24, high: 44 },
  other: { low: 28, high: 55 }
};

const COUNTRY_REGION = {
  AL: "europe", AD: "europe", AT: "europe", BY: "europe",
  BE: "europe", BA: "europe", BG: "europe", HR: "europe",
  CY: "europe", CZ: "europe", DK: "europe", EE: "europe",
  FI: "europe", FR: "europe", DE: "europe", GR: "europe",
  HU: "europe", IS: "europe", IE: "europe", IT: "europe",
  XK: "europe", LV: "europe", LI: "europe", LT: "europe",
  LU: "europe", MT: "europe", MD: "europe", MC: "europe",
  ME: "europe", NL: "europe", MK: "europe", NO: "europe",
  PL: "europe", PT: "europe", RO: "europe", SM: "europe",
  RS: "europe", SK: "europe", SI: "europe", ES: "europe",
  SE: "europe", CH: "europe", UA: "europe", VA: "europe",

  US: "northAmerica", CA: "northAmerica",

  BZ: "centralAmerica", CR: "centralAmerica", SV: "centralAmerica",
  GT: "centralAmerica", HN: "centralAmerica", MX: "centralAmerica",
  NI: "centralAmerica", PA: "centralAmerica",

  AG: "caribbean", BS: "caribbean", BB: "caribbean",
  CU: "caribbean", DM: "caribbean", DO: "caribbean",
  GD: "caribbean", HT: "caribbean", JM: "caribbean",
  KN: "caribbean", LC: "caribbean", VC: "caribbean",
  TT: "caribbean",

  AR: "southAmerica", BO: "southAmerica", BR: "southAmerica",
  CL: "southAmerica", CO: "southAmerica", EC: "southAmerica",
  GY: "southAmerica", PY: "southAmerica", PE: "southAmerica",
  SR: "southAmerica", UY: "southAmerica", VE: "southAmerica",

  BH: "middleEast", IQ: "middleEast",
  IL: "middleEast", JO: "middleEast", KW: "middleEast",
  LB: "middleEast", OM: "middleEast", PS: "middleEast",
  QA: "middleEast", SA: "middleEast", SY: "middleEast",
  AE: "middleEast", YE: "middleEast", TR: "middleEast",

  DZ: "northAfrica", EG: "northAfrica", LY: "northAfrica",
  MA: "northAfrica", SD: "northAfrica", TN: "northAfrica",

  AO: "subSaharanAfrica", BW: "subSaharanAfrica",
  CM: "subSaharanAfrica", CV: "subSaharanAfrica",
  CI: "subSaharanAfrica", CD: "subSaharanAfrica",
  CG: "subSaharanAfrica", ET: "subSaharanAfrica",
  GH: "subSaharanAfrica", KE: "subSaharanAfrica",
  LS: "subSaharanAfrica", MG: "subSaharanAfrica",
  MW: "subSaharanAfrica", MU: "subSaharanAfrica",
  MZ: "subSaharanAfrica", NA: "subSaharanAfrica",
  NG: "subSaharanAfrica", RW: "subSaharanAfrica",
  SN: "subSaharanAfrica", SC: "subSaharanAfrica",
  SL: "subSaharanAfrica", SO: "subSaharanAfrica",
  ZA: "subSaharanAfrica", TZ: "subSaharanAfrica",
  UG: "subSaharanAfrica", ZM: "subSaharanAfrica",
  ZW: "subSaharanAfrica",

  CN: "eastAsia", HK: "eastAsia", JP: "eastAsia",
  KP: "eastAsia", KR: "eastAsia", MO: "eastAsia",
  MN: "eastAsia", TW: "eastAsia",

  AF: "southAsia", BD: "southAsia", BT: "southAsia",
  IN: "southAsia", MV: "southAsia", NP: "southAsia",
  PK: "southAsia", LK: "southAsia",

  BN: "southEastAsia", KH: "southEastAsia",
  ID: "southEastAsia", LA: "southEastAsia",
  MY: "southEastAsia", MM: "southEastAsia",
  PH: "southEastAsia", SG: "southEastAsia",
  TH: "southEastAsia", TL: "southEastAsia",
  VN: "southEastAsia",

  KZ: "centralAsia", KG: "centralAsia", TJ: "centralAsia",
  TM: "centralAsia", UZ: "centralAsia",

  AU: "oceania", FJ: "oceania", KI: "oceania",
  MH: "oceania", FM: "oceania", NR: "oceania",
  NZ: "oceania", PW: "oceania", PG: "oceania",
  WS: "oceania", SB: "oceania", TO: "oceania",
  TV: "oceania", VU: "oceania"
};

function destinationEstimate(country) {
  const specific = SHIPPING_BY_COUNTRY[country];

  if (specific) {
    return {
      status: "planning_estimate",
      low: specific.low,
      high: specific.high,
      scope: "country",
      basis:
        "Planning range for this destination. It is not a carrier quote and the final price depends on parcel size, weight, dimensions, service level and carrier."
    };
  }

  const region =
    COUNTRY_REGION[country] || "other";

  const range =
    SHIPPING_BY_REGION[region] ||
    SHIPPING_BY_REGION.other;

  return {
    status: "regional_planning_estimate",
    low: range.low,
    high: range.high,
    scope: "regional",
    region,
    basis:
      `Regional planning range for ${region}. It is not a carrier quote and the final price depends on parcel size, weight, dimensions, service level and carrier.`
  };
}

const IMPORT_TAX_RULES = {
  AU: {
    name: "Australia",
    mode: "indicative",
    rate: 0.10,
    label: "GST",
    basis:
      "Indicative 10% GST calculation. Australian low-value-goods rules, exemptions, duty, valuation and collection arrangements can change the actual amount."
  },

  NZ: {
    name: "New Zealand",
    mode: "indicative",
    rate: 0.15,
    label: "GST",
    basis:
      "Indicative 15% GST calculation. Customs valuation, duty, levies, exemptions and collection arrangements can change the actual amount."
  },

  PG: {
    name: "Papua New Guinea",
    mode: "indicative",
    rate: 0.10,
    label: "GST",
    basis:
      "Indicative 10% GST calculation. PNG applies GST at 10% to most goods and to most imported goods, but exemptions, duty, valuation and clearance arrangements can change the actual amount."
  },

  DE: {
    name: "Germany",
    mode: "indicative",
    rate: 0.19,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  FR: {
    name: "France",
    mode: "indicative",
    rate: 0.20,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  ES: {
    name: "Spain",
    mode: "indicative",
    rate: 0.21,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  NL: {
    name: "Netherlands",
    mode: "indicative",
    rate: 0.21,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  IT: {
    name: "Italy",
    mode: "indicative",
    rate: 0.22,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  BE: {
    name: "Belgium",
    mode: "indicative",
    rate: 0.21,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  AT: {
    name: "Austria",
    mode: "indicative",
    rate: 0.20,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  IE: {
    name: "Ireland",
    mode: "indicative",
    rate: 0.23,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  PT: {
    name: "Portugal",
    mode: "indicative",
    rate: 0.23,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  SE: {
    name: "Sweden",
    mode: "indicative",
    rate: 0.25,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  DK: {
    name: "Denmark",
    mode: "indicative",
    rate: 0.25,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  FI: {
    name: "Finland",
    mode: "indicative",
    rate: 0.255,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  PL: {
    name: "Poland",
    mode: "indicative",
    rate: 0.23,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  CZ: {
    name: "Czechia",
    mode: "indicative",
    rate: 0.21,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  GR: {
    name: "Greece",
    mode: "indicative",
    rate: 0.24,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  HU: {
    name: "Hungary",
    mode: "indicative",
    rate: 0.27,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  RO: {
    name: "Romania",
    mode: "indicative",
    rate: 0.21,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  },

  HR: {
    name: "Croatia",
    mode: "indicative",
    rate: 0.25,
    label: "import VAT",
    basis:
      "Indicative standard-rate import VAT. Reduced rates, customs duty, collection arrangements and clearance fees can change the actual amount."
  }
};

function unknownImportTax(
  basis = "We do not have enough verified information to calculate destination import charges safely."
) {
  return {
    status: "unknown",
    low: null,
    high: null,
    label: "Import taxes",
    basis
  };
}

function indicativeImportTax(
  country,
  customsBaseLowGbp,
  customsBaseHighGbp
) {
  const rule =
    IMPORT_TAX_RULES[country];

  if (
    !rule ||
    customsBaseLowGbp === null ||
    customsBaseHighGbp === null
  ) {
    return unknownImportTax(
      !rule
        ? "We do not currently have a verified indicative VAT/GST profile for this destination. The estimate can still be calculated; import tax is simply excluded until a verified rate/rule is available."
        : "We do not have enough information to establish the customs-value range. The estimate can still be calculated without an import-tax figure."
    );
  }

  const low =
    customsBaseLowGbp * rule.rate;

  const high =
    customsBaseHighGbp * rule.rate;

  return {
    status: "indicative",
    low,
    high,
    label: `Potential ${rule.label}`,
    basis:
      `${(rule.rate * 100).toFixed(
        rule.rate === 0.255 ? 1 : 0
      )}% standard-rate indication applied across the estimated customs-value range. This is not a customs quote and does not include potentially applicable duty or carrier/clearance fees. ${rule.basis}`
  };
}

function customsDutyEstimate() {
  return {
    status: "unknown",
    low: null,
    high: null,
    label: "Customs duty",
    basis:
      "Not included. A defensible duty calculation normally requires product classification, origin and destination-specific tariff information."
  };
}

async function convertToGbp(amount, currency) {
  const code = normaliseCurrency(currency);

  if (!code || code === "GBP") {
    return {
      status: "confirmed",
      amount,
      currency: "GBP",
      basis: "Price already supplied in GBP."
    };
  }

  try {
    const response = await fetch(
      `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(code)}/GBP`,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error("FX lookup failed.");
    }

    const data = await response.json();

    if (
      !Number.isFinite(data.rate) ||
      data.rate <= 0
    ) {
      throw new Error("Invalid FX rate.");
    }

    return {
      status: "estimated",
      amount: amount * data.rate,
      currency: "GBP",
      rate: data.rate,
      source:
        "Frankfurter/ECB reference-rate service",
      basis:
        "Converted using the latest available reference rate. The retailer, card provider or payment provider may use a different exchange rate or add a foreign-exchange fee."
    };
  } catch {
    return {
      status: "unknown",
      amount: null,
      currency: "GBP",
      basis:
        `We could not obtain a current ${code}/GBP reference rate.`
    };
  }
}

function getCountryName(country) {
  const names = {
    US: "United States",
    CA: "Canada",
    AU: "Australia",
    NZ: "New Zealand",
    JP: "Japan",
    KR: "South Korea",
    SG: "Singapore",
    AE: "United Arab Emirates",
    IN: "India",
    ZA: "South Africa",
    BR: "Brazil",
    AR: "Argentina",
    CL: "Chile",
    IL: "Israel",
    TR: "Türkiye",
    NO: "Norway",
    CH: "Switzerland",
    IS: "Iceland",
    DE: "Germany",
    FR: "France",
    ES: "Spain",
    NL: "Netherlands",
    BE: "Belgium",
    AT: "Austria",
    IE: "Ireland",
    IT: "Italy",
    PT: "Portugal",
    SE: "Sweden",
    DK: "Denmark",
    FI: "Finland",
    PL: "Poland",
    CZ: "Czechia",
    GR: "Greece",
    HU: "Hungary",
    RO: "Romania",
    HR: "Croatia",
    PG: "Papua New Guinea"
  };

  return names[country] || country;
}

function calculateEstimate({
  productGbp,
  ukShipping,
  destinationShipping,
  destination
}) {
  const serviceFee = {
    status: "confirmed",
    amount: SERVICE_FEE_GBP
  };

  const ukShippingKnown =
    ukShipping &&
    ukShipping.status === "confirmed" &&
    Number.isFinite(ukShipping.amount);

  const ukAmount =
    ukShippingKnown
      ? ukShipping.amount
      : null;

  const shippingKnown =
    destinationShipping &&
    Number.isFinite(destinationShipping.low) &&
    Number.isFinite(destinationShipping.high);

  const customsBaseLow =
    shippingKnown
      ? productGbp +
        (ukAmount ?? 0) +
        destinationShipping.low
      : null;

  const customsBaseHigh =
    shippingKnown
      ? productGbp +
        (ukAmount ?? 0) +
        destinationShipping.high
      : null;

  const importTax =
    indicativeImportTax(
      destination,
      customsBaseLow,
      customsBaseHigh
    );

  const customsDuty =
    customsDutyEstimate();

  const low =
    productGbp +
    SERVICE_FEE_GBP +
    (ukAmount ?? 0) +
    (shippingKnown
      ? destinationShipping.low
      : 0) +
    (importTax.low ?? 0);

  const high =
    productGbp +
    SERVICE_FEE_GBP +
    (ukAmount ?? 0) +
    (shippingKnown
      ? destinationShipping.high
      : 0) +
    (importTax.high ?? 0);

  const unresolved = [];

  if (!ukShippingKnown) {
    unresolved.push(
      "Retailer → UK delivery"
    );
  }

  if (!shippingKnown) {
    unresolved.push(
      "UK → destination shipping"
    );
  }

  // Import tax and customs duty are recipient-side/indicative costs.
  // They must never block the core Get It, Send It estimate.

  return {
    product: {
      status: "confirmed",
      amount: productGbp
    },

    ukShipping,

    destinationShipping,

    serviceFee,

    importTax,

    customsDuty,

    total: {
      status:
        unresolved.length === 0
          ? "estimated"
          : "partial",
      low,
      high,
      currency: "GBP"
    },

    unresolved,

    vatWarning:
      "UK VAT treatment depends on the actual purchase/export arrangement. This estimate does not assume that UK VAT is automatically zero-rated.",

    destination:
      getCountryName(destination),

    rulesVersion:
      RULES_VERSION
  };
}

async function handleProductRequest(
  request,
  url
) {
  const productUrl =
    url.searchParams.get("url");

  const destination =
    (
      url.searchParams.get(
        "destination"
      ) || ""
    )
      .toUpperCase()
      .trim();

  if (!productUrl) {
    return jsonResponse(
      {
        success: false,
        error:
          "Please provide a product URL."
      },
      400
    );
  }

  if (!destination) {
    return jsonResponse(
      {
        success: false,
        error:
          "Please provide a destination country."
      },
      400
    );
  }

  let target;

  try {
    target = new URL(productUrl);
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "That doesn't appear to be a valid URL."
      },
      400
    );
  }

  if (
    !ALLOWED_PROTOCOLS.has(
      target.protocol
    )
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Only web URLs are supported."
      },
      400
    );
  }

  if (
    isPrivateHostname(
      target.hostname
    )
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "That URL cannot be accessed."
      },
      400
    );
  }

  let page;

  try {
    page = await fetchRetailer(
      target.toString()
    );
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "We couldn't access that product page.",
        needsManualPrice: true,
        destinationShipping:
          destinationEstimate(
            destination
          ),
        importTax:
          unknownImportTax(
            "The retailer page could not be accessed, so destination import charges cannot yet be estimated."
          ),
        customsDuty:
          customsDutyEstimate(),
        serviceFee: {
          status: "confirmed",
          amount: SERVICE_FEE_GBP
        },
        rulesVersion:
          RULES_VERSION
      },
      502
    );
  }

  if (!page.ok) {
    return jsonResponse(
      {
        success: false,
        error:
          page.status === 403
            ? "The retailer is blocking automated access to this product page."
            : `The retailer returned HTTP ${page.status}.`,
        needsManualPrice: true,
        destinationShipping:
          destinationEstimate(
            destination
          ),
        importTax:
          unknownImportTax(
            "The retailer page could not be accessed, so destination import charges cannot yet be estimated."
          ),
        customsDuty:
          customsDutyEstimate(),
        serviceFee: {
          status: "confirmed",
          amount: SERVICE_FEE_GBP
        },
        rulesVersion:
          RULES_VERSION
      },
      502
    );
  }

  let product =
    extractProductFromHtml(
      page.html
    );

  if (!product) {
    product = await fetchShopifyProduct(
      target.toString()
    );
  }

  if (!product) {
    const shipping =
      await findUkShipping(
        page.html,
        page.finalUrl,
        null
      );

    return jsonResponse({
      success: false,
      error:
        "We couldn't automatically find the product price.",
      needsManualPrice: true,
      ukShipping: shipping,
      destinationShipping:
        destinationEstimate(
          destination
        ),
      importTax:
        unknownImportTax(
          "The product price could not be established, so destination import charges cannot be estimated yet."
        ),
      customsDuty:
        customsDutyEstimate(),
      serviceFee: {
        status: "confirmed",
        amount: SERVICE_FEE_GBP
      },
      rulesVersion:
        RULES_VERSION
    });
  }

  const shipping =
    await findUkShipping(
      page.html,
      page.finalUrl,
      product.price
    );

  const destinationShipping =
    destinationEstimate(
      destination
    );

  const fx =
    await convertToGbp(
      product.price,
      product.currency
    );

  if (fx.status === "unknown") {
    return jsonResponse({
      success: false,
      error: fx.basis,
      needsManualPrice: true,
      product: {
        name: product.name,
        price: product.price,
        currency: product.currency,
        availability:
          product.availability
      },
      ukShipping: shipping,
      destinationShipping,
      importTax:
        unknownImportTax(
          fx.basis
        ),
      customsDuty:
        customsDutyEstimate(),
      serviceFee: {
        status: "confirmed",
        amount: SERVICE_FEE_GBP
      },
      rulesVersion:
        RULES_VERSION
    });
  }

  const estimate =
    calculateEstimate({
      productGbp: fx.amount,
      ukShipping: shipping,
      destinationShipping,
      destination
    });

  return jsonResponse({
    success: true,

    product: {
      name: product.name,
      price: product.price,
      currency: product.currency,
      priceGbp: fx.amount,
      availability:
        product.availability
    },

    fx,

    ...estimate
  });
}

async function handleManualEstimate(
  request,
  url
) {
  const productPrice =
    cleanPrice(
      url.searchParams.get(
        "price"
      )
    );

  const currency =
    normaliseCurrency(
      url.searchParams.get(
        "currency"
      ) || "GBP"
    );

  const destination =
    (
      url.searchParams.get(
        "destination"
      ) || ""
    )
      .toUpperCase()
      .trim();

  const ukShippingRaw =
    cleanPrice(
      url.searchParams.get(
        "ukShipping"
      )
    );

  if (
    productPrice === null ||
    productPrice < 0
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Please provide a valid product price."
      },
      400
    );
  }

  if (!destination) {
    return jsonResponse(
      {
        success: false,
        error:
          "Please provide a destination country."
      },
      400
    );
  }

  const fx =
    await convertToGbp(
      productPrice,
      currency
    );

  if (fx.status === "unknown") {
    return jsonResponse({
      success: false,
      error: fx.basis,
      rulesVersion:
        RULES_VERSION
    });
  }

  const ukShipping =
    ukShippingRaw !== null
      ? {
          status: "confirmed",
          amount: ukShippingRaw,
          basis:
            "UK delivery amount supplied by the customer."
        }
      : {
          status: "unknown",
          amount: null,
          basis:
            "UK delivery was not supplied and could not be established automatically."
        };

  const destinationShipping =
    destinationEstimate(
      destination
    );

  const estimate =
    calculateEstimate({
      productGbp: fx.amount,
      ukShipping,
      destinationShipping,
      destination
    });

  return jsonResponse({
    success: true,

    product: {
      name: null,
      price: productPrice,
      currency,
      priceGbp: fx.amount,
      availability: null
    },

    fx,

    ...estimate
  });
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    if (
      url.pathname ===
      "/api/product"
    ) {
      if (
        request.method !== "GET"
      ) {
        return jsonResponse(
          {
            success: false,
            error:
              "Method not allowed."
          },
          405
        );
      }

      return handleProductRequest(
        request,
        url
      );
    }

    if (
      url.pathname ===
      "/api/estimate"
    ) {
      if (
        request.method !== "GET"
      ) {
        return jsonResponse(
          {
            success: false,
            error:
              "Method not allowed."
          },
          405
        );
      }

      return handleManualEstimate(
        request,
        url
      );
    }

    return env.ASSETS.fetch(
      request
    );
  }
};
