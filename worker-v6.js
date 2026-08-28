import baseWorker from "./worker-v2.js";

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

function detectVatStatus(text) {
  const value = String(text || "");
  if (/(?:including|inclusive of|incl\.?|inc\.?)[\s-]*(?:UK\s*)?VAT\b|\bVAT\s+(?:included|inclusive)\b/i.test(value)) {
    return {
      status: "included",
      basis: "The retailer explicitly indicates that the displayed price includes VAT."
    };
  }
  if (/(?:excluding|exclusive of|ex\.?|exc\.?)[\s-]*(?:UK\s*)?VAT\b|\bVAT\s+(?:excluded|exclusive)\b|\bplus\s+VAT\b/i.test(value)) {
    return {
      status: "excluded",
      basis: "The retailer explicitly indicates that VAT is excluded from the displayed price."
    };
  }
  return {
    status: "unknown",
    basis: "The retailer data did not clearly state whether the displayed price includes VAT."
  };
}

function normaliseVatStatus(value, fallbackText = "") {
  if (typeof value === "boolean") {
    return value
      ? { status: "included", basis: "The retailer data explicitly says tax is included." }
      : { status: "excluded", basis: "The retailer data explicitly says tax is not included." };
  }
  if (typeof value === "string") {
    if (/included|inclusive/i.test(value)) return { status: "included", basis: "The retailer data indicates VAT/tax is included." };
    if (/excluded|exclusive|plus/i.test(value)) return { status: "excluded", basis: "The retailer data indicates VAT/tax is excluded." };
  }
  return detectVatStatus(fallbackText);
}

function getAuthHeader(apiKey) {
  const bytes = new TextEncoder().encode(`${apiKey}:`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function fetchShopifyProductFixed(productUrl) {
  let url;
  try {
    url = new URL(productUrl);
  } catch {
    return null;
  }

  const match = url.pathname.match(/\/products\/([^/?#]+)/i);
  if (!match) return null;

  const handle = decodeURIComponent(match[1]);
  const endpoint = `${url.origin}/products/${encodeURIComponent(handle)}.js`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; GetItSendIt/1.5; +https://getitsendit.co.uk)"
      },
      redirect: "follow",
      cache: "no-store"
    });
    if (!response.ok) return null;

    const data = await response.json();
    const variants = Array.isArray(data?.variants) ? data.variants : [];
    const available = variants.find(v => v && v.available && v.price !== undefined);
    const variant = available || variants.find(v => v?.price !== undefined);
    const raw = data?.price ?? data?.price_min ?? variant?.price;
    const numeric = cleanPrice(raw);
    if (numeric === null || numeric <= 0) return null;

    // Shopify Ajax Product API monetary fields are returned in the currency
    // subunit (e.g. 799 means £7.99; 79900 means £799.00).
    const price = numeric / 100;
    if (!Number.isFinite(price) || price <= 0 || price >= 100000) return null;

    const vatStatus = normaliseVatStatus(
      data?.taxes_included,
      `${data?.title || ""} ${data?.description || ""}`
    );

    return {
      name: data?.title || null,
      price,
      currency: String(data?.currency || "GBP").toUpperCase(),
      availability: data?.available === false ? "OutOfStock" : data?.available === true ? "InStock" : null,
      vatStatus,
      source: "shopify_ajax_fixed"
    };
  } catch {
    return null;
  }
}

async function zyteProduct(env, productUrl, extractFrom, options = {}) {
  if (!env?.ZYTE_API_KEY) return { ok: false, reason: "zyte_api_key_missing", extractFrom };

  const maxAttempts = options.retry520 ? 3 : 1;
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = {
        url: productUrl,
        product: true,
        productOptions: { extractFrom, ai: true }
      };
      if (extractFrom === "browserHtml") body.browserHtml = true;
      if (extractFrom === "httpResponseBody") body.httpResponseBody = true;
      if (options.geolocation) body.geolocation = options.geolocation;

      const response = await fetch("https://api.zyte.com/v1/extract", {
        method: "POST",
        headers: {
          "Authorization": getAuthHeader(env.ZYTE_API_KEY),
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      const product = data?.product || null;
      const price = cleanPrice(product?.price);
      const currency = String(product?.currency || "").toUpperCase();
      const probability = Number(product?.metadata?.probability ?? 0);
      const vatStatus = normaliseVatStatus(
        product?.taxesIncluded ?? product?.vatIncluded ?? product?.vatStatus,
        product?.name || ""
      );

      attempts.push({ attempt, status: response.status, price, currency, probability, ok: response.ok });

      const result = {
        ok: response.ok && !!product && price !== null && price > 0 && !!currency,
        status: response.status,
        extractFrom,
        price,
        currency,
        probability,
        product,
        vatStatus,
        attempts,
        responsePreview: response.ok ? null : text.slice(0, 1500)
      };

      if (result.ok || response.status !== 520 || attempt === maxAttempts) return result;
      await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    } catch (error) {
      attempts.push({ attempt, networkError: String(error?.message || error) });
      if (attempt === maxAttempts) {
        return { ok: false, reason: "zyte_request_failed", extractFrom, attempts, error: String(error?.message || error) };
      }
    }
  }

  return { ok: false, reason: "zyte_request_failed", extractFrom, attempts };
}

async function getZyteProduct(env, productUrl) {
  const isHmUk = (() => {
    try {
      const u = new URL(productUrl);
      return HM_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.toLowerCase().includes("/en_gb/");
    } catch {
      return false;
    }
  })();

  const http = await zyteProduct(env, productUrl, "httpResponseBody");
  if (http.ok) return { ...http, source: "zyte_http_product" };

  const browser = await zyteProduct(env, productUrl, "browserHtml", {
    retry520: true,
    ...(isHmUk ? { geolocation: "GB" } : {})
  });
  if (browser.ok) return { ...browser, source: "zyte_browser_product" };

  return {
    ok: false,
    reason: env?.ZYTE_API_KEY ? "zyte_no_product_price" : "zyte_api_key_missing",
    http,
    browser
  };
}

function addPngImportTax(data, destination) {
  if (destination !== "PG" || !data) return data;
  const product = Number(data.product?.amount ?? data.product?.priceGbp);
  const uk = data.ukShipping;
  const dest = data.destinationShipping;
  const ukAmount = uk?.status === "confirmed" && Number.isFinite(Number(uk.amount)) ? Number(uk.amount) : 0;
  const lowShipping = Number(dest?.low);
  const highShipping = Number(dest?.high);

  if (!Number.isFinite(product) || !Number.isFinite(lowShipping) || !Number.isFinite(highShipping)) return data;

  const customsLow = product + ukAmount + lowShipping;
  const customsHigh = product + ukAmount + highShipping;
  const lowTax = customsLow * 0.10;
  const highTax = customsHigh * 0.10;

  const unresolved = Array.isArray(data.unresolved) ? data.unresolved.filter(x => x !== "Destination import taxes") : [];
  if (data.customsDuty?.status === "unknown" && !unresolved.includes("Customs duty")) unresolved.push("Customs duty");

  const low = product + Number(data.serviceFee?.amount || 0) + ukAmount + lowShipping + lowTax;
  const high = product + Number(data.serviceFee?.amount || 0) + ukAmount + highShipping + highTax;

  return {
    ...data,
    importTax: {
      status: "indicative",
      low: lowTax,
      high: highTax,
      label: "Potential GST",
      basis: "Indicative 10% PNG GST applied to the estimated customs-value range. This does not include potentially applicable duty, exemptions or carrier/clearance charges."
    },
    total: {
      ...(data.total || {}),
      status: unresolved.length === 0 ? "estimated" : "partial",
      low,
      high,
      currency: "GBP"
    },
    unresolved
  };
}

async function calculateEstimate(request, env, product) {
  const incoming = new URL(request.url);
  const destination = (incoming.searchParams.get("destination") || "").toUpperCase().trim();
  const estimateUrl = new URL("https://internal.local/api/estimate");
  estimateUrl.searchParams.set("price", String(product.price));
  estimateUrl.searchParams.set("currency", product.currency || "GBP");
  estimateUrl.searchParams.set("destination", destination);

  try {
    const response = await baseWorker.fetch(new Request(estimateUrl.toString(), { method: "GET" }), env);
    const data = await response.json();
    if (!data?.success) return null;
    return addPngImportTax(data, destination);
  } catch {
    return null;
  }
}

async function handleProduct(request, env) {
  const incoming = new URL(request.url);
  const productUrl = incoming.searchParams.get("url");
  const destination = (incoming.searchParams.get("destination") || "").toUpperCase().trim();

  if (!productUrl || !destination) return baseWorker.fetch(request, env);

  const shopify = await fetchShopifyProductFixed(productUrl);
  if (shopify) {
    const estimate = await calculateEstimate(request, env, shopify);
    if (estimate) {
      return jsonResponse({
        ...estimate,
        success: true,
        product: {
          ...(estimate.product || {}),
          name: shopify.name,
          price: shopify.price,
          currency: shopify.currency,
          priceGbp: shopify.currency === "GBP" ? shopify.price : estimate.product?.priceGbp,
          availability: shopify.availability
        },
        vatStatus: shopify.vatStatus,
        lookupMethod: shopify.source,
        sourceUrl: productUrl
      });
    }
  }

  try {
    const native = await baseWorker.fetch(request, env);
    const nativeText = await native.clone().text();
    let nativeData = null;
    try { nativeData = JSON.parse(nativeText); } catch {}
    const nativePrice = cleanPrice(nativeData?.product?.priceGbp ?? nativeData?.product?.price);
    if (nativeData?.success && nativePrice !== null && nativePrice > 0) {
      return new Response(nativeText, { status: native.status, headers: native.headers });
    }
  } catch {}

  const zyte = await getZyteProduct(env, productUrl);
  if (zyte.ok) {
    const currency = String(zyte.currency || "GBP").toUpperCase();
    const product = {
      articleCode: getHMArticleCode(productUrl),
      name: zyte.product?.name || null,
      price: zyte.price,
      currency,
      availability: zyte.product?.availability || null,
      vatStatus: zyte.vatStatus,
      source: zyte.source
    };

    const estimate = await calculateEstimate(request, env, product);
    if (estimate) {
      return jsonResponse({
        ...estimate,
        success: true,
        product: {
          ...(estimate.product || {}),
          name: product.name || estimate.product?.name || null,
          price: product.price,
          currency: product.currency,
          priceGbp: product.currency === "GBP" ? product.price : estimate.product?.priceGbp,
          availability: product.availability || estimate.product?.availability || null
        },
        vatStatus: product.vatStatus,
        lookupMethod: product.source,
        articleCode: product.articleCode,
        sourceUrl: productUrl
      });
    }

    return jsonResponse({
      success: true,
      product: {
        name: product.name,
        price: product.price,
        currency: product.currency,
        priceGbp: product.currency === "GBP" ? product.price : null,
        availability: product.availability
      },
      vatStatus: product.vatStatus,
      lookupMethod: product.source,
      articleCode: product.articleCode,
      sourceUrl: productUrl,
      serviceFee: { status: "confirmed", amount: 15 },
      warning: "The product price was found automatically, but the full delivery estimate could not be calculated."
    });
  }

  return baseWorker.fetch(request, env);
}

function enhanceHomePage(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>
          #gis-loading-message {
            display:none;
            margin-top:18px;
            padding:18px 20px;
            border-radius:14px;
            background:#fff7f1;
            border:1px solid #f6c9af;
            color:#8d3f1b;
            font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          }
          #gis-loading-message.show { display:flex; align-items:center; gap:12px; }
          #gis-loading-message strong { font-size:16px; font-weight:800; }
          #gis-loading-dot { width:10px; height:10px; min-width:10px; border-radius:50%; background:#F36A21; animation:gisPulse 1s ease-in-out infinite; }
          @keyframes gisPulse { 0%,100% { transform:scale(.8); opacity:.45; } 50% { transform:scale(1.15); opacity:1; } }
        </style>`, { html:true });
      }
    })
    .on("body", {
      element(element) {
        element.append(`<script>
          (() => {
            const run = () => {
              const result = document.getElementById('result');
              const button = document.getElementById('estimateBtn');
              if (!button || !result) return;
              let box = document.getElementById('gis-loading-message');
              if (!box) {
                box = document.createElement('div');
                box.id = 'gis-loading-message';
                box.innerHTML = '<span id="gis-loading-dot"></span><strong>We\'re calculating how much it\'ll cost to get this to you!</strong>';
                button.insertAdjacentElement('afterend', box);
              }
              const originalFetch = window.fetch;
              if (window.__gisFetchWrapped) return;
              window.__gisFetchWrapped = true;
              window.fetch = async (...args) => {
                const first = String(args[0] || '');
                const isEstimate = first.includes('/api/product');
                if (isEstimate) {
                  box.classList.add('show');
                  result.classList.remove('show');
                }
                try {
                  const response = await originalFetch(...args);
                  return response;
                } finally {
                  if (isEstimate) box.classList.remove('show');
                }
              };
              const relabel = () => {
                const rangeLabel = document.getElementById('rangeLabel');
                const allRow = document.getElementById('allInRow');
                const allLabel = allRow ? allRow.querySelector('span') : null;
                const importLabel = document.querySelector('#importTax')?.parentElement?.querySelector('span');
                if (rangeLabel && !rangeLabel.dataset.gisRelabelled) {
                  rangeLabel.textContent = 'Amount payable to Get It, Send It — before local taxes or import charges.';
                  rangeLabel.dataset.gisRelabelled = '1';
                }
                if (importLabel) importLabel.textContent = 'Estimated local taxes & import charges';
                if (allLabel) allLabel.textContent = 'Potential total including local taxes';
              };
              const observer = new MutationObserver(relabel);
              observer.observe(document.body, { childList:true, subtree:true, characterData:true });
              relabel();
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
          })();
        </script>`, { html:true });
      }
    })
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-zyte" && request.method === "GET") {
      const productUrl = url.searchParams.get("url");
      if (!productUrl) return jsonResponse({ success: false, error: "Missing product URL." }, 400);
      const result = await getZyteProduct(env, productUrl);
      return jsonResponse({ success: result.ok, zyteConfigured: Boolean(env?.ZYTE_API_KEY), result }, result.ok ? 200 : 502);
    }

    if (url.pathname === "/api/product" && request.method === "GET") return handleProduct(request, env);

    if (url.pathname === "/api/estimate" && request.method === "GET") {
      const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();
      const response = await baseWorker.fetch(request, env);
      let data = null;
      try { data = await response.clone().json(); } catch {}
      if (data?.success) return jsonResponse(addPngImportTax(data, destination), response.status);
      return response;
    }

    const response = await baseWorker.fetch(request, env);
    if (url.pathname === "/" || url.pathname === "/index.html") return enhanceHomePage(response);
    return response;
  }
};
