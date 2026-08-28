import currentWorker from "./worker-v6.js";

const STANDARD_UK_VAT = 0.20;

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function parseVatStatus(value) {
  if (!value) return { status: "unknown", basis: "VAT treatment could not be established from the retailer data." };
  const status = String(value.status || value).toLowerCase();
  if (status === "included" || /include|inclusive/.test(status)) {
    return { status: "included", basis: value.basis || "The retailer indicates that VAT is included in the displayed price." };
  }
  if (status === "excluded" || /exclude|exclusive|plus/.test(status)) {
    return { status: "excluded", basis: value.basis || "The retailer indicates that VAT is excluded from the displayed price." };
  }
  return { status: "unknown", basis: value.basis || "VAT treatment could not be established from the retailer data." };
}

function addUkVatLayer(data) {
  if (!data || !data.success || !data.product) return data;

  const vatStatus = parseVatStatus(data.vatStatus);
  const displayedPrice = Number(data.product.priceGbp);
  if (!Number.isFinite(displayedPrice) || displayedPrice < 0) return { ...data, vatStatus };

  let purchasePriceGbp = displayedPrice;
  let ukVat = { status: "unknown", amount: null, rate: null, label: "UK VAT", basis: vatStatus.basis };

  if (vatStatus.status === "excluded") {
    const vatAmount = displayedPrice * STANDARD_UK_VAT;
    purchasePriceGbp = displayedPrice + vatAmount;
    ukVat = {
      status: "indicative",
      amount: vatAmount,
      rate: STANDARD_UK_VAT,
      label: "Estimated UK VAT",
      basis: "20% standard-rate UK VAT added because the retailer indicates the displayed price is ex VAT. Some goods can have different VAT treatment, so this is an indicative planning figure rather than a tax determination."
    };
  } else if (vatStatus.status === "included") {
    ukVat = {
      status: "included",
      amount: null,
      rate: null,
      label: "UK VAT",
      basis: "The displayed retailer price already includes VAT, so no VAT is added again."
    };
  }

  const originalProduct = Number(data.product.priceGbp);
  const ratio = originalProduct > 0 ? purchasePriceGbp / originalProduct : 1;
  const scale = (value) => Number.isFinite(Number(value)) ? Number(value) * ratio : value;

  // The destination-side import-tax calculation from v6 is based on the
  // purchase price. When explicit ex-VAT pricing is detected, recalculate
  // the destination tax base using the VAT-inclusive purchase price.
  const destinationShipping = data.destinationShipping;
  const ukShipping = data.ukShipping;
  const fee = Number(data.serviceFee?.amount || 15);
  const ukAmount = ukShipping?.status === "confirmed" && Number.isFinite(Number(ukShipping.amount)) ? Number(ukShipping.amount) : 0;
  const lowShip = Number(destinationShipping?.low);
  const highShip = Number(destinationShipping?.high);
  const taxRateMatch = String(data.importTax?.basis || "").match(/([0-9]+(?:\.[0-9]+)?)%/);
  const destinationRate = taxRateMatch ? Number(taxRateMatch[1]) / 100 : null;

  let importTax = data.importTax;
  let total = data.total;

  if (Number.isFinite(lowShip) && Number.isFinite(highShip) && Number.isFinite(destinationRate)) {
    const customsLow = purchasePriceGbp + ukAmount + lowShip;
    const customsHigh = purchasePriceGbp + ukAmount + highShip;
    const lowTax = customsLow * destinationRate;
    const highTax = customsHigh * destinationRate;

    importTax = {
      ...(data.importTax || {}),
      low: lowTax,
      high: highTax
    };

    total = {
      ...(data.total || {}),
      low: purchasePriceGbp + fee + ukAmount + lowShip + lowTax,
      high: purchasePriceGbp + fee + ukAmount + highShip + highTax,
      currency: "GBP"
    };
  } else if (data.total && vatStatus.status === "excluded") {
    total = {
      ...data.total,
      low: scale(data.total.low),
      high: scale(data.total.high),
      currency: "GBP"
    };
  }

  return {
    ...data,
    product: {
      ...data.product,
      purchasePriceGbp,
      displayedPriceGbp: displayedPrice,
      priceGbp: purchasePriceGbp
    },
    vatStatus,
    ukVat,
    importTax,
    total
  };
}

function enhanceHomePage(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>
          #waitingMessage {
            display:none;
            margin-top:17px;
            padding:18px 20px;
            border:1px solid #f4c7aa;
            border-radius:13px;
            background:#fff7f1;
            color:#9a411b;
            font-size:16px;
            font-weight:800;
            line-height:1.35;
            text-align:center;
            box-shadow:0 8px 24px rgba(243,106,33,.08);
          }
          #waitingMessage.show { display:block; }
          #waitingMessage::after { content:""; display:inline-block; width:9px; height:9px; margin-left:9px; border-radius:50%; background:#F36A21; vertical-align:2px; animation:gisPulse 1s ease-in-out infinite; }
          @keyframes gisPulse { 0%,100%{opacity:.35;transform:scale(.82)} 50%{opacity:1;transform:scale(1.12)} }
        </style>`, { html:true });
      }
    })
    .on("body", {
      element(element) {
        element.append(`<script>
          (() => {
            const init = () => {
              const result = document.getElementById('result');
              const waiting = document.getElementById('waitingMessage');
              if (!result || !waiting || window.__gisV7Ui) return;
              window.__gisV7Ui = true;

              const observeResult = () => {
                const rangeLabel = document.getElementById('rangeLabel');
                const importRow = document.getElementById('importTax')?.parentElement;
                const allInRow = document.getElementById('allInRow');
                const allLabel = allInRow?.querySelector('span');
                if (rangeLabel) rangeLabel.textContent = 'Amount payable to Get It, Send It — before local taxes or import charges.';
                if (importRow) {
                  const label = importRow.querySelector('span');
                  if (label) label.textContent = 'Estimated local taxes & import charges';
                }
                if (allLabel) allLabel.textContent = 'Potential total including local taxes';

                let vatRow = document.getElementById('gisVatRow');
                if (!vatRow) {
                  vatRow = document.createElement('div');
                  vatRow.id = 'gisVatRow';
                  vatRow.style.display = 'none';
                  vatRow.innerHTML = '<span>UK VAT</span><strong id="gisVatValue">—</strong>';
                  const productRow = document.getElementById('productCost')?.parentElement;
                  productRow?.insertAdjacentElement('afterend', vatRow);
                }
              };

              new MutationObserver(observeResult).observe(document.body, {childList:true, subtree:true, characterData:true});
              observeResult();
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
          })();
        </script>`, { html:true });
      }
    })
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/product" && request.method === "GET") {
      const response = await currentWorker.fetch(request, env);
      let data = null;
      try { data = await response.clone().json(); } catch {}
      if (data?.success) return jsonResponse(addUkVatLayer(data), response.status, Object.fromEntries(response.headers));
      return response;
    }

    if (url.pathname === "/api/estimate" && request.method === "GET") {
      const response = await currentWorker.fetch(request, env);
      let data = null;
      try { data = await response.clone().json(); } catch {}
      if (data?.success) return jsonResponse(addUkVatLayer(data), response.status, Object.fromEntries(response.headers));
      return response;
    }

    const response = await currentWorker.fetch(request, env);
    if (url.pathname === "/" || url.pathname === "/index.html") return enhanceHomePage(response);
    return response;
  }
};
