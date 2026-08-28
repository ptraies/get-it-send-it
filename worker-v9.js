import currentWorker from "./worker-v8.js";
import { getTaxProfile } from "./tax-profiles.js";

function jsonResponse(data, status = 200, headers = {}) {
  const cleanHeaders = {
    "content-type": "application/json; charset=UTF-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    ...headers
  };
  delete cleanHeaders["content-length"];
  return new Response(JSON.stringify(data), { status, headers: cleanHeaders });
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function applyGlobalTaxProfile(data, destination) {
  if (!data?.success) return data;
  const profile = getTaxProfile(destination);
  if (!profile) return data;

  const product = finite(data.product?.priceGbp ?? data.product?.price);
  const uk = data.ukShipping;
  const ukAmount = uk?.status === "confirmed" && finite(uk.amount) !== null ? finite(uk.amount) : 0;
  const shipLow = finite(data.destinationShipping?.low);
  const shipHigh = finite(data.destinationShipping?.high);
  const fee = finite(data.serviceFee?.amount) ?? 15;

  if (product === null || shipLow === null || shipHigh === null) {
    return { ...data, taxProfile: profile, taxCalculation: { status: "partial", reason: "Insufficient shipping/value data for destination tax calculation." } };
  }

  const customsLow = product + ukAmount + shipLow;
  const customsHigh = product + ukAmount + shipHigh;
  let importTax;
  let total;

  if (profile.mode === "rate" && profile.maxRate > 0) {
    const lowTax = customsLow * profile.minRate;
    const highTax = customsHigh * profile.maxRate;
    importTax = {
      status: "indicative",
      low: lowTax,
      high: highTax,
      label: profile.taxName,
      basis: `${profile.displayRate} indicative ${profile.taxName} for ${profile.name}. Product/category-specific rates, exemptions, thresholds, duty and carrier/clearance charges may change the actual amount.`,
      rateMin: profile.minRate,
      rateMax: profile.maxRate,
      taxProfile: profile
    };
    total = {
      status: "estimated",
      low: product + ukAmount + fee + shipLow + lowTax,
      high: product + ukAmount + fee + shipHigh + highTax,
      currency: "GBP"
    };
  } else if (profile.mode === "complex") {
    importTax = {
      status: "unknown",
      low: 0,
      high: 0,
      label: profile.taxName,
      basis: `${profile.name}: ${profile.note} We have not included an unverified destination tax amount in the estimate.`,
      taxProfile: profile
    };
    total = {
      status: "partial",
      low: product + ukAmount + fee + shipLow,
      high: product + ukAmount + fee + shipHigh,
      currency: "GBP"
    };
  } else {
    importTax = {
      status: "none",
      low: 0,
      high: 0,
      label: profile.taxName,
      basis: `${profile.name}: no general VAT/GST rate is indicated by the current tax profile. Customs duty or other import charges may still apply.`,
      taxProfile: profile
    };
    total = {
      status: "estimated",
      low: product + ukAmount + fee + shipLow,
      high: product + ukAmount + fee + shipHigh,
      currency: "GBP"
    };
  }

  return { ...data, taxProfile: profile, importTax, total };
}

function enhanceHomePage(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  return new HTMLRewriter()
    .on("head", { element(element) {
      element.append(`<style>.gis-v9-tax-note{margin-top:12px;font-size:11px;line-height:1.5;color:#7A7F84}</style>`, { html:true });
    }})
    .on("body", { element(element) {
      element.append(`<script>
        (() => {
          const init = () => {
            if (window.__gisV9Ui) return;
            window.__gisV9Ui = true;
            const result = document.getElementById('result');
            if (!result) return;
            const update = () => {
              const productRow = document.getElementById('productCost')?.parentElement;
              const taxRow = document.getElementById('importTax')?.parentElement;
              const allInRow = document.getElementById('allInRow');
              const productData = window.__gisLastEstimate;
              if (productRow) {
                const label = productRow.querySelector('span');
                if (label) {
                  const status = String(productData?.vatStatus?.status || productData?.ukVat?.status || '').toLowerCase();
                  label.textContent = status === 'included' ? 'Product price (incl. VAT)' : status === 'excluded' || status === 'indicative' ? 'Product price (excl. VAT + VAT)' : 'Product price';
                }
              }
              if (taxRow) {
                const label = taxRow.querySelector('span');
                if (label) label.textContent = 'Estimated local taxes & import charges';
              }
              const taxValue = document.getElementById('importTax');
              if (taxValue && productData?.importTax) {
                const it = productData.importTax;
                if (it.status === 'indicative') {
                  const lo = Number(it.low), hi = Number(it.high);
                  taxValue.textContent = Math.abs(lo-hi) < 0.005 ? '~£' + lo.toFixed(2) : '~£' + lo.toFixed(2) + '–£' + hi.toFixed(2);
                } else if (it.status === 'none') taxValue.textContent = 'None indicated';
                else taxValue.textContent = 'Not included';
                taxValue.title = it.basis || '';
              }
              if (allInRow && productData?.total) {
                const label = allInRow.querySelector('span');
                if (label) label.textContent = productData.total.status === 'partial' ? 'Total before unverified local taxes' : 'Potential total including local taxes';
              }
            };
            const nativeFetch = window.fetch.bind(window);
            window.fetch = async (...args) => {
              const response = await nativeFetch(...args);
              try { const clone = response.clone(); if ((clone.headers.get('content-type')||'').includes('application/json')) { const data = await clone.json(); if (data?.success && data?.taxProfile) window.__gisLastEstimate = data; } } catch {}
              setTimeout(update, 0); return response;
            };
            new MutationObserver(update).observe(document.body, {childList:true,subtree:true,characterData:true});
            update();
          };
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
        })();
      </script>`, { html:true });
    }})
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === "/api/product" || url.pathname === "/api/estimate") && request.method === "GET") {
      const response = await currentWorker.fetch(request, env);
      let data = null;
      try { data = await response.clone().json(); } catch {}
      const destination = (url.searchParams.get("destination") || "").toUpperCase().trim();
      if (data?.success && destination) return jsonResponse(applyGlobalTaxProfile(data, destination), response.status, Object.fromEntries(response.headers));
      return response;
    }
    const response = await currentWorker.fetch(request, env);
    if (url.pathname === "/" || url.pathname === "/index.html") return enhanceHomePage(response);
    return response;
  }
};
