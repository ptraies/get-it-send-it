// Carrier-backed international shipping rates for Get It, Send It.
// Source: Royal Mail current online price guides and country-zone guide,
// checked 29 Aug 2026. Rates below are online International Tracked prices.
// Small parcels use 250g, 500g, 750g, 1kg, 1.25kg, 1.5kg and 2kg bands.
// Heavier uses 1kg, 2kg, 3kg, 4kg, 5kg, 7.5kg, 10kg, 15kg and 20kg bands.

const SMALL_WEIGHTS_KG = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const HEAVY_WEIGHTS_KG = [1, 2, 3, 4, 5, 7.5, 10, 15, 20];

const EUROPE_ZONE_1 = new Set(["IE", "FR", "DE", "DK", "MC"]);
const EUROPE_ZONE_2 = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "EE", "FI", "GR", "HU", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);
const EUROPE_ZONE_3 = new Set(["AL", "MD", "AD", "AM", "AZ", "NO", "BY", "BA", "SM", "ME", "MK", "RS", "GE", "CH", "TJ", "GI", "TR", "GL", "TM", "IS", "UA", "KZ", "XK", "UZ", "LI", "VA"]);
const WORLD_ZONE_2 = new Set(["AU", "PW", "IO", "CX", "CC", "CK", "FJ", "PF", "TF", "KI", "MO", "NR", "NC", "NZ", "NU", "NF", "BV", "PG", "LA", "PN", "SG", "SB", "TK", "TO", "TV", "AS", "WS"]);

const SMALL_RATES = {
  // Europe Zone 1
  IE: [8.80, 8.80, 8.80, 8.80, 10.30, 10.30, 10.30],
  FR: [9.90, 10.85, 11.10, 11.15, 11.15, 11.15, 11.15],
  DE: [8.15, 9.40, 9.95, 9.95, 9.95, 9.95, 9.95],
  DK: [8.95, 10.05, 10.70, 10.95, 11.80, 11.80, 12.00],
  // Europe Zone 2
  AT: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  BG: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  HR: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  CY: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  CZ: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  EE: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  FI: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  GR: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  HU: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  LV: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  LT: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  LU: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  MT: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  NL: [9.20, 10.10, 10.65, 10.85, 11.25, 11.25, 11.90],
  PL: [9.85, 10.70, 11.30, 12.00, 12.45, 12.45, 13.15],
  PT: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  RO: [14.15, 15.00, 15.60, 16.30, 16.75, 16.75, 17.45],
  SK: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  SI: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  ES: [9.60, 10.20, 10.75, 11.40, 11.85, 11.85, 12.50],
  SE: [9.65, 10.60, 11.15, 11.90, 12.30, 12.30, 13.00],
  BE: [9.65, 10.60, 11.15, 11.90, 12.30, 12.30, 13.00],
  IT: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  // Europe Zone 3
  NO: [10.90, 12.50, 13.05, 14.05, 15.00, 15.60, 16.05],
  CH: [11.95, 11.95, 12.25, 13.20, 13.75, 14.30, 14.55],
  TR: [11.65, 13.90, 14.50, 15.65, 16.75, 17.45, 17.95],
  // World exact pricing
  BR: [12.30, 15.60, 19.20, 22.30, 25.15, 26.15, 28.05],
  CA: [14.44, 14.44, 17.01, 20.27, 22.95, 24.52, 24.52],
  CN: [11.40, 13.15, 13.15, 13.15, 17.75, 17.75, 17.75],
  HK: [11.55, 14.35, 17.15, 19.90, 22.40, 25.40, 27.25],
  IN: [12.50, 15.80, 18.50, 21.45, 24.15, 25.10, 26.90],
  JP: [12.45, 15.70, 18.50, 21.45, 24.15, 27.10, 29.10],
  PK: [14.40, 18.15, 21.25, 24.65, 27.75, 28.85, 29.90],
  TH: [12.95, 15.70, 18.25, 20.10, 22.45, 24.80, 26.60],
  AU: [12.35, 15.85, 18.40, 19.40, 25.10, 25.10, 25.10],
  NZ: [15.30, 16.30, 20.25, 20.25, 27.20, 30.05, 32.05],
  US: [12.17, 14.25, 17.53, 17.53, 20.20, 20.20, 20.20]
};

const SMALL_ZONE_DEFAULTS = {
  europe1: [8.95, 10.05, 10.70, 10.95, 11.80, 11.80, 12.00],
  europe2: [9.85, 10.70, 11.45, 12.10, 12.45, 12.45, 13.15],
  europe3: [12.15, 14.40, 15.00, 16.15, 17.25, 17.95, 18.45],
  world1: [14.40, 18.15, 21.25, 24.65, 27.75, 28.85, 29.90],
  world2: [14.90, 19.15, 23.75, 27.90, 31.85, 34.90, 37.55],
  world3: [12.17, 14.25, 17.53, 17.53, 20.20, 20.20, 20.20]
};

const HEAVY_RATES = {
  BR: [25.85, 28.80, 29.85, 38.90, 48.40, 65.35, 99.75, 125.95, 173.40],
  CA: [24.10, 25.05, 29.40, 32.85, 37.90, 48.25, 63.25, 65.00, 68.80],
  CN: [25.35, 28.25, 33.45, 39.15, 46.95, 54.05, 67.80, 93.50, 110.00],
  HK: [26.35, 29.40, 31.25, 39.70, 46.90, 60.35, 79.75, 105.95, 133.40],
  IN: [25.85, 28.80, 32.50, 38.60, 49.40, 56.55, 69.75, 88.00, 109.45],
  JP: [27.40, 30.55, 31.35, 37.90, 44.40, 60.35, 74.75, 108.95, 128.40],
  PK: [27.90, 31.10, 35.55, 42.55, 53.35, 71.85, 107.75, 138.20, 190.50],
  TH: [27.40, 30.55, 34.85, 41.75, 52.35, 70.55, 99.90, 135.70, 187.05],
  AU: [27.50, 35.10, 38.85, 45.50, 49.50, 63.95, 80.30, 123.40, 170.00],
  NZ: [27.50, 36.50, 40.40, 46.00, 55.00, 70.00, 91.20, 128.35, 177.15],
  US: [25.20, 31.50, 32.40, 39.80, 45.50, 59.50, 76.00, 110.70, 133.00]
};

const HEAVY_ZONE_DEFAULTS = {
  europe1: [14.30, 15.20, 17.35, 17.85, 18.40, 24.05, 29.25, 39.65, 49.45],
  europe2: [13.55, 16.40, 19.00, 34.25, 37.40, 55.55, 68.55, 78.65, 85.25],
  europe3: [17.30, 24.25, 28.35, 35.85, 42.25, 59.00, 80.60, 103.00, 118.00],
  world1: [27.90, 31.10, 35.55, 42.55, 53.35, 71.85, 107.75, 138.20, 190.50],
  world2: [29.70, 37.90, 41.95, 46.60, 55.95, 76.25, 105.75, 143.20, 184.70],
  world3: [25.20, 31.50, 32.40, 39.80, 45.50, 59.50, 76.00, 110.70, 133.00]
};

function zoneFor(country) {
  if (country === "US") return "world3";
  if (EUROPE_ZONE_1.has(country)) return "europe1";
  if (EUROPE_ZONE_2.has(country)) return "europe2";
  if (EUROPE_ZONE_3.has(country)) return "europe3";
  if (WORLD_ZONE_2.has(country)) return "world2";
  return "world1";
}

function rateForWeight(weightKg, weights, rates) {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  const index = weights.findIndex(limit => weightKg <= limit);
  if (index < 0 || !rates?.[index]) return null;
  return { price: rates[index], weightBandKg: weights[index] };
}

function inferWeightKg(product, productUrl) {
  const direct = Number(product?.weightKg);
  const text = [product?.name, productUrl].filter(Boolean).join(" ");
  const match = text.match(/(?:^|[\s(])([0-9]+(?:[.,][0-9]+)?)\s*(kg|g)\b/i);
  if (match) {
    const value = Number(match[1].replace(",", "."));
    if (Number.isFinite(value) && value > 0) return match[2].toLowerCase() === "kg" ? value : value / 1000;
  }
  if (Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

function estimatePackedWeightKg(unitWeightKg, quantity) {
  const productWeightKg = unitWeightKg * quantity;
  // Product pages normally give contents/product weight rather than packed parcel weight.
  // Add a conservative packaging allowance: at least 100g, or 15% for heavier shipments,
  // capped at 750g. This keeps light products in the correct carrier band without pretending
  // that packaging weighs nothing.
  const packagingKg = Math.min(0.75, Math.max(0.10, productWeightKg * 0.15));
  return { productWeightKg, packagingKg, packedWeightKg: productWeightKg + packagingKg };
}

function ratesFor(country, heavy) {
  const zone = zoneFor(country);
  const exact = heavy ? HEAVY_RATES[country] : SMALL_RATES[country];
  const defaults = heavy ? HEAVY_ZONE_DEFAULTS[zone] : SMALL_ZONE_DEFAULTS[zone];
  return { zone, rates: exact || defaults };
}

export function estimateInternationalShipping(country, quantity, product, productUrl = "") {
  const q = Math.max(1, Math.floor(Number(quantity) || 1));
  const unitWeightKg = inferWeightKg(product, productUrl);
  if (!Number.isFinite(unitWeightKg) || unitWeightKg <= 0) {
    return null;
  }

  const { productWeightKg, packagingKg, packedWeightKg } = estimatePackedWeightKg(unitWeightKg, q);
  const heavy = packedWeightKg > 2;
  const { zone, rates } = ratesFor(country, heavy);
  const bands = heavy ? HEAVY_WEIGHTS_KG : SMALL_WEIGHTS_KG;
  const selected = rateForWeight(packedWeightKg, bands, rates);
  if (!selected) return null;

  return {
    status: "estimated",
    amount: selected.price,
    low: selected.price,
    high: selected.price,
    currency: "GBP",
    carrier: "Royal Mail",
    service: heavy ? "International Tracked Heavier" : "International Tracked",
    pricing: "current online rate",
    zone,
    productWeightKg,
    packagingKg,
    packedWeightKg,
    weightBandKg: selected.weightBandKg,
    basis: `Based on Royal Mail current online ${heavy ? "International Tracked Heavier" : "International Tracked"} pricing for ${selected.weightBandKg}kg or less. Estimated product weight is ${(productWeightKg * 1000).toFixed(0)}g and estimated packed weight is ${(packedWeightKg * 1000).toFixed(0)}g, using a ${Math.round(packagingKg * 1000)}g packaging allowance. Actual dimensions, packaging and carrier service may change the final postage charge.`
  };
}
