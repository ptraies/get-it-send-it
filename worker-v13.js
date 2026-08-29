import currentWorker from "./worker-v12.js";

const SERVICE_FEE_MIN = 15;
const SERVICE_FEE_RATE = 0.15;
const TAX_ENGINE_UPDATED = "29 August 2026";

function jsonResponse(data, status = 200, headers = {}) {
  const clean = { ...headers };
  delete clean["content-length"];
  clean["content-type"] = "application/json; charset=UTF-8";
  clean["cache-control"] = "no-store";
  return new Response(JSON.stringify(data), { status, headers: clean });
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function recalcQuantity(data, quantity) {
  if (!data?.success || !data.product) return data;
  const q = Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1)));
  const singlePrice = num(data.product.priceGbp ?? data.product.price);
  if (singlePrice === null) return data;

  const baseProduct = { ...(data.product || {}) };
  const productPrice = Math.round(singlePrice * q * 100) / 100;
  const fee = Math.max(SERVICE_FEE_MIN, productPrice * SERVICE_FEE_RATE);
  const roundedFee = Math.round(fee * 100) / 100;

  const baseShippingLow = num(data.destinationShipping?.low);
  const baseShippingHigh = num(data.destinationShipping?.high);
  let shipping = data.destinationShipping;
  let lowShip = baseShippingLow;
  let highShip = baseShippingHigh;

  const weightKg = num(data.shippingInput?.weightKg);
  if (weightKg !== null && baseShippingLow !== null && baseShippingHigh !== null) {
    // The v11 shipping profile is already weight-aware for one unit. For multiple
    // identical units we apply a conservative band multiplier to the existing range
    // rather than simply multiplying postage linearly.
    let multiplier = 1;
    if (q === 2) multiplier = 1.55;
    else if (q === 3) multiplier = 1.95;
    else if (q <= 5) multiplier = 2.35;
    else if (q <= 10) multiplier = 3.2;
    else multiplier = 4.5;
    lowShip = Math.round(baseShippingLow * multiplier * 100) / 100;
    highShip = Math.round(baseShippingHigh * multiplier * 100) / 100;
    shipping = {
      ...data.destinationShipping,
      low: lowShip,
      high: highShip,
      quantity: q,
      estimatedShipmentWeightKg: Math.round(weightKg * q * 100) / 100,
      basis: `${data.destinationShipping?.basis || ""} Multiple identical units are treated as one combined shipment where practical; shipping is not assumed to multiply one-for-one.`
    };
  } else if (baseShippingLow !== null && baseShippingHigh !== null) {
    const multiplier = q === 1 ? 1 : Math.min(4.5, 1 + Math.log2(q) * 0.72);
    lowShip = Math.round(baseShippingLow * multiplier * 100) / 100;
    highShip = Math.round(baseShippingHigh * multiplier * 100) / 100;
    shipping = {
      ...data.destinationShipping,
      low: lowShip,
      high: highShip,
      quantity: q,
      basis: `${data.destinationShipping?.basis || ""} Multiple identical units are treated as one combined shipment where practical; product weight was not available, so the shipping range remains a planning estimate.`
    };
  }

  const uk = data.ukShipping?.status === "confirmed" ? (num(data.ukShipping.amount) ?? 0) : 0;
  const taxRateMin = num(data.importTax?.rateMin);
  const taxRateMax = num(data.importTax?.rateMax);
  let importTax = data.importTax;
  let lowTax = 0;
  let highTax = 0;
  if (data.importTax?.status === "indicative" && lowShip !== null && highShip !== null && taxRateMin !== null && taxRateMax !== null) {
    lowTax = (productPrice + uk + lowShip) * taxRateMin;
    highTax = (productPrice + uk + highShip) * taxRateMax;
    importTax = { ...data.importTax, low: Math.round(lowTax * 100) / 100, high: Math.round(highTax * 100) / 100 };
  }

  const oldFee = num(data.serviceFee?.amount) ?? SERVICE_FEE_MIN;
  let total = data.total;
  if (lowShip !== null && highShip !== null) {
    total = {
      ...(data.total || {}),
      low: Math.round((productPrice + uk + roundedFee + lowShip + lowTax) * 100) / 100,
      high: Math.round((productPrice + uk + roundedFee + highShip + highTax) * 100) / 100,
      currency: "GBP",
      quantity: q
    };
  }

  return {
    ...data,
    quantity: q,
    product: { ...baseProduct, priceGbp: productPrice, price: productPrice, quantity: q, unitPriceGbp: singlePrice },
    serviceFee: { status: "confirmed", amount: roundedFee, rate: SERVICE_FEE_RATE, minimum: SERVICE_FEE_MIN, basis: `Service fee is the greater of £${SERVICE_FEE_MIN.toFixed(2)} or ${(SERVICE_FEE_RATE * 100).toFixed(0)}% of the total product price. Shipping and destination taxes are excluded.` },
    destinationShipping: shipping,
    importTax,
    total,
    quoteContext: { singleUnitProductPriceGbp: singlePrice, quantity: q, previousServiceFeeGbp: oldFee }
  };
}

function confidence(data) {
  if (!data?.success) return { level: "unknown", label: "Unable to estimate", reason: "We could not establish enough information to produce an estimate." };
  if (data.destinationShipping?.status === "specialist_quote") return { level: "manual", label: "Specialist quote", reason: "The product falls outside our standard parcel planning range." };
  const priceSource = String(data.product?.source || data.product?.lookupMethod || "").toLowerCase();
  const weightKnown = num(data.shippingInput?.weightKg) !== null;
  const shippingKnown = data.destinationShipping?.status === "planning_estimate" || data.destinationShipping?.status === "weight_aware_planning_estimate";
  if (priceSource && weightKnown && shippingKnown) return { level: "high", label: "Higher confidence", reason: "Product price and physical weight were established; shipping is based on a weight-aware planning band." };
  if (weightKnown) return { level: "medium", label: "Planning estimate", reason: "Product weight was established, but some shipping or retailer details remain estimates." };
  return { level: "low", label: "Planning estimate", reason: "Product weight or shipping details were not available, so a broader planning range is being used." };
}

function addQuoteAndQuantityUi(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  return new HTMLRewriter()
    .on("head", { element(element) {
      element.append(`<style>
        .gis-quantity{margin-top:15px}.gis-quantity-row{display:flex;align-items:center;justify-content:space-between;border:1px solid #CFC9BC;border-radius:13px;background:#fff;padding:5px 7px 5px 15px}.gis-quantity-controls{display:flex;align-items:center;gap:10px}.gis-qbtn{width:34px;height:34px;border:1px solid #D5D0C5;border-radius:10px;background:#F7F3EA;color:#173B8F;font-weight:850;cursor:pointer}.gis-qnum{min-width:25px;text-align:center;font-weight:800;color:#173B8F}.gis-result-extra{margin-top:16px}.gis-confidence{padding:12px 14px;border:1px solid #DDD8CC;border-radius:12px;background:#F8F6F0;font-size:11px;color:#68717C}.gis-confidence strong{color:#173B8F}.gis-confidence-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#F36A21}.gis-quote-card{margin-top:18px;padding:17px;border:1px solid #C8D3EA;border-radius:14px;background:#F5F7FC}.gis-quote-card h3{font-family:var(--serif);font-size:21px;color:var(--cobalt);margin:0 0 5px}.gis-quote-card p{font-size:12px;color:#5D6670;margin:0 0 12px}.gis-quote-btn{width:100%;border:0;border-radius:12px;background:var(--cobalt);color:#fff;font-weight:850;padding:14px 16px;cursor:pointer}.gis-quote-btn:hover{filter:brightness(.96)}.gis-fee-help{margin-top:8px;font-size:10px;color:#7A7F84}.gis-fee-help button{border:0;background:none;padding:0;color:var(--cobalt);text-decoration:underline;cursor:pointer;font-size:inherit}.gis-quote-modal{display:none;position:fixed;inset:0;background:rgba(23,32,42,.42);z-index:9999;padding:24px;overflow:auto}.gis-quote-modal.show{display:block}.gis-quote-panel{max-width:560px;margin:7vh auto;background:var(--paper);border-radius:18px;border:1px solid var(--line);box-shadow:0 24px 70px rgba(23,59,143,.2);padding:24px}.gis-quote-panel h2{font-size:34px;margin:0 0 7px}.gis-quote-close{float:right;border:0;background:transparent;font-size:26px;color:#68717C;cursor:pointer}.gis-quote-summary{background:#F4F1E9;border:1px solid #E1DBCD;border-radius:12px;padding:13px;margin:16px 0;font-size:12px}.gis-quote-form label{display:block;font-size:11px;font-weight:800;color:#69717A;text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px}.gis-quote-form input,.gis-quote-form textarea{width:100%;padding:12px 14px;border:1px solid #CFC9BC;border-radius:11px;background:#fff;outline:none}.gis-quote-form textarea{min-height:90px;resize:vertical}.gis-quote-form button{width:100%;border:0;border-radius:12px;background:var(--orange);color:#fff;font-weight:850;padding:14px;margin-top:15px;cursor:pointer}.gis-quote-help{font-size:10px;color:#7A7F84;margin-top:8px;line-height:1.45}.gis-quote-success{display:none;margin-top:12px;padding:12px;border-radius:10px;background:#F1FBF3;border:1px solid #BFE5C8;color:#2E8A4F;font-size:11px;line-height:1.5}.gis-quote-success.show{display:block}.gis-section-note{font-size:12px;color:#68717C;line-height:1.5;margin:0}.gis-faq-item{border-top:1px solid var(--line);padding:16px 0}.gis-faq-q{display:flex;justify-content:space-between;gap:18px;font-family:var(--serif);font-size:19px;color:var(--cobalt);cursor:pointer}.gis-faq-a{display:none;font-size:13px;color:#616A74;padding-top:8px;line-height:1.55}.gis-faq-item.open .gis-faq-a{display:block}.gis-last-updated{font-size:10px;color:#7A7F84;text-align:center;margin-top:10px}.gis-news-history-panel{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line);display:none}.gis-news-history-panel.show{display:block}
        @media(max-width:820px){.gis-quote-modal{padding:12px}.gis-quote-panel{margin:2vh auto}}
      </style>`, {html:true});
    }})
    .on("body", { element(element) {
      element.append(`<script>
        (() => {
          const init = () => {
            if (window.__gisV13Ui) return;
            window.__gisV13Ui = true;
            const result = document.getElementById('result');
            const estimateBtn = document.getElementById('estimateBtn');
            const country = document.getElementById('country');
            const urlInput = document.getElementById('url');
            if (!result || !estimateBtn || !country || !urlInput) return;
            let quantity = 1;
            let lastData = null;

            const ensureQuantity = () => {
              if (document.getElementById('gisQuantity')) return;
              const wrap = document.createElement('div');
              wrap.className = 'gis-quantity'; wrap.id = 'gisQuantity';
              wrap.innerHTML = '<div class="field-label">Quantity</div><div class="gis-quantity-row"><span>How many would you like?</span><div class="gis-quantity-controls"><button type="button" class="gis-qbtn" id="gisQMinus" aria-label="Decrease quantity">−</button><span class="gis-qnum" id="gisQNum">1</span><button type="button" class="gis-qbtn" id="gisQPlus" aria-label="Increase quantity">+</button></div></div>';
              country.parentElement.insertAdjacentElement('beforebegin', wrap);
              const refresh = (newQuantity) => { quantity = Math.max(1, Math.min(99, newQuantity)); document.getElementById('gisQNum').textContent = quantity; if(lastData) render(lastData); };
              document.getElementById('gisQMinus').onclick = () => refresh(quantity - 1);
              document.getElementById('gisQPlus').onclick = () => refresh(quantity + 1);
            };

            const render = (data) => {
              lastData = data;
              const qData = data?.success ? data : null;
              const extra = document.getElementById('gisResultExtra');
              if (!extra || !qData) return;
              const confidenceData = qData.__confidence || { level:'low', label:'Planning estimate', reason:'Some information is estimated.' };
              const weight = Number(qData.shippingInput?.weightKg);
              const specialist = qData.destinationShipping?.status === 'specialist_quote';
              extra.innerHTML = '<div class="gis-confidence"><span class="gis-confidence-dot"></span><strong>'+confidenceData.label+'</strong> — '+confidenceData.reason+(Number.isFinite(weight) ? ' Product weight: approximately '+weight.toFixed(2)+' kg.' : '')+'</div>'+
                '<div class="gis-fee-help">Your service fee is the greater of £15 or 15% of the product price only. <button type="button" id="gisFeeHelp">What does the fee cover?</button></div>'+
                '<div class="gis-quote-card"><h3>'+(specialist ? 'This one needs a specialist quote.' : 'Ready to get an official quote?')+'</h3><p>'+(specialist ? 'We would rather confirm the shipping than guess at a heavy or specialist parcel.' : 'We’ll confirm the retailer cost, shipping, taxes and any other applicable charges before you commit.')+'</p><button type="button" class="gis-quote-btn" id="gisQuoteBtn">'+(specialist ? 'REQUEST A SHIPPING QUOTE →' : 'GET AN OFFICIAL QUOTE →')+'</button></div>';
              document.getElementById('gisQuoteBtn').onclick = openQuote;
              document.getElementById('gisFeeHelp').onclick = () => alert('The service fee covers the work involved in sourcing, purchasing and arranging delivery. It is the greater of £15 or 15% of the product price. Shipping and local taxes are separate.');
            };

            const updateFromEstimate = () => {
              if (!lastData) return;
              const data = JSON.parse(JSON.stringify(lastData));
              data.quantity = quantity;
              if(data.product) data.product.quantity = quantity;
              data.__confidence = confidence(data);
              render(data);
            };

            ensureQuantity();

            const nativeFetch = window.fetch.bind(window);
            window.fetch = async (...args) => {
              const res = await nativeFetch(...args);
              try {
                const clone = res.clone();
                const type = clone.headers.get('content-type') || '';
                if (type.includes('application/json')) {
                  const data = await clone.json();
                  if (data?.success && (String(args[0]||'').includes('/api/product') || String(args[0]||'').includes('/api/estimate'))) {
                    const url = new URL(String(args[0]), window.location.href);
                    url.searchParams.set('quantity', String(quantity));
                    // Store the live response. Quantity is also recalculated server-side by v13 on direct calls.
                    lastData = data;
                    setTimeout(updateFromEstimate, 0);
                  }
                }
              } catch {}
              return res;
            };

            const modalHtml = document.createElement('div');
            modalHtml.className = 'gis-quote-modal'; modalHtml.id = 'gisQuoteModal'; modalHtml.innerHTML = '<div class="gis-quote-panel"><button class="gis-quote-close" type="button" aria-label="Close">×</button><h2>Get an official quote.</h2><p class="gis-section-note">We’ll use the estimate below as a starting point and confirm the exact costs before you commit.</p><div class="gis-quote-summary" id="gisQuoteSummary"></div><form class="gis-quote-form" id="gisQuoteForm"><label for="gisQuoteName">Name</label><input id="gisQuoteName" required autocomplete="name"><label for="gisQuoteEmail">Email</label><input id="gisQuoteEmail" type="email" required autocomplete="email"><label for="gisQuoteNote">Anything we should know?</label><textarea id="gisQuoteNote" placeholder="Variant, colour, timing, or anything else..."></textarea><button type="submit">PREPARE MY QUOTE REQUEST →</button><div class="gis-quote-help">We’ll confirm the exact retailer, shipping and tax costs before an official quote is issued.</div><div class="gis-quote-success" id="gisQuoteSuccess"></div></form></div>';
            document.body.appendChild(modalHtml);
            modalHtml.querySelector('.gis-quote-close').onclick = () => modalHtml.classList.remove('show');
            modalHtml.addEventListener('click', e => { if(e.target === modalHtml) modalHtml.classList.remove('show'); });

            function openQuote(){
              ensureQuantity();
              const d = lastData || {};
              document.getElementById('gisQuoteSummary').textContent = `${d.product?.name || 'Linked product'} · Qty ${quantity} · ${country.options[country.selectedIndex]?.text || country.value} · Product price £${Number(d.product?.unitPriceGbp ?? d.product?.priceGbp ?? d.product?.price ?? 0).toFixed(2)} each`;
              document.getElementById('gisQuoteSuccess').classList.remove('show');
              modalHtml.classList.add('show');
            }

            document.getElementById('gisQuoteForm').addEventListener('submit', async e => {
              e.preventDefault();
              const d = lastData || {};
              const payload = { name: document.getElementById('gisQuoteName').value.trim(), email: document.getElementById('gisQuoteEmail').value.trim(), note: document.getElementById('gisQuoteNote').value.trim(), url: urlInput.value.trim(), destination: country.value, quantity, estimate: d };
              try {
                const response = await fetch('/api/quote', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
                const out = await response.json();
                if(!response.ok || !out?.success) throw new Error(out?.message || 'Quote request could not be sent.');
                document.getElementById('gisQuoteSuccess').textContent = out.message || 'Your quote request has been received.';
                document.getElementById('gisQuoteSuccess').classList.add('show');
              } catch(err) {
                const subject = encodeURIComponent('Official quote request — Get It, Send It');
                const body = encodeURIComponent(`Name: ${payload.name}\nEmail: ${payload.email}\nProduct: ${d.product?.name || ''}\nLink: ${payload.url}\nDestination: ${country.options[country.selectedIndex]?.text || payload.destination}\nQuantity: ${quantity}\nEstimate: ${d.total?.low != null ? '£'+Number(d.total.low).toFixed(2)+'–£'+Number(d.total.high).toFixed(2) : 'specialist quote'}\n\nNotes:\n${payload.note}`);
                const success = document.getElementById('gisQuoteSuccess');
                success.innerHTML = `Your request is ready. We couldn't send it automatically yet. <a href="mailto:?subject=${subject}&body=${body}">Open your email app to send it →</a>`;
                success.classList.add('show');
              }
            });

            // Insert the post-result content only once.
            const resultObserver = new MutationObserver(() => {
              if (!document.getElementById('gisResultExtra') && result.classList.contains('show')) {
                const holder = document.createElement('div'); holder.id = 'gisResultExtra'; holder.className = 'gis-result-extra'; result.appendChild(holder); render(lastData || {});
              }
            });
            resultObserver.observe(result, {childList:true,subtree:true});

            // Add FAQ and last-updated section below the existing page.
            const main = document.querySelector('main');
            if (main && !document.getElementById('gisMoreInfo')) {
              const section = document.createElement('section'); section.className = 'intro'; section.id = 'gisMoreInfo';
              section.innerHTML = '<div class="wrap"><div class="center"><div class="eyebrow">A little more clarity</div><h2>How Get It, Send It works.</h2><p class="sub">A free estimate gives you a planning figure. When you want to proceed, we confirm the real costs and issue an official quote.</p><div class="gis-faq-item"><div class="gis-faq-q">Can I order more than one? <span>+</span></div><div class="gis-faq-a">Yes. Choose the quantity in the estimator. Identical items are treated as one combined shipment where practical, so shipping is not simply multiplied by the number of units.</div></div><div class="gis-faq-item"><div class="gis-faq-q">Is the estimate exact? <span>+</span></div><div class="gis-faq-a">No. It is a planning estimate. Where product weight and retailer information are available, the estimate becomes more precise. An official quote confirms the exact costs.</div></div><div class="gis-faq-item"><div class="gis-faq-q">What does the service fee cover? <span>+</span></div><div class="gis-faq-a">The fee pays for the work involved in sourcing, purchasing and arranging delivery. It is the greater of £15 or 15% of the product price only.</div></div><div class="gis-faq-item"><div class="gis-faq-q">What happens after I request an official quote? <span>+</span></div><div class="gis-faq-a">We use your estimate as the starting point, confirm retailer price and availability, verify shipping and applicable charges, then come back with the official figure before you commit.</div></div><div class="gis-faq-item"><div class="gis-faq-q">What if the product is very large or heavy? <span>+</span></div><div class="gis-faq-a">We won't invent a shipping maximum. Where an item falls outside our standard parcel planning range, we'll ask for a specialist shipping quote instead.</div></div><div class="gis-last-updated">Tax planning rules last reviewed: ${TAX_ENGINE_UPDATED}. Estimates are indicative and will evolve as destination information improves.</div></div></section>';
              main.appendChild(section);
              section.querySelectorAll('.gis-faq-q').forEach(q => q.addEventListener('click', () => q.parentElement.classList.toggle('open')));
            }
          };
          if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
        })();
      </script>`, {html:true});
    }})
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === '/api/product' || url.pathname === '/api/estimate') && request.method === 'GET') {
      const response = await currentWorker.fetch(request, env);
      let data = null; try { data = await response.clone().json(); } catch {}
      if (data?.success) return jsonResponse(recalcQuantity(data, url.searchParams.get('quantity') || 1), response.status, Object.fromEntries(response.headers));
      return response;
    }
    if (url.pathname === '/api/quote' && request.method === 'POST') {
      // Quote submission plumbing is intentionally isolated. If a QUOTE_EMAIL
      // secret is later configured, this endpoint can be switched to outbound email.
      return jsonResponse({ success: false, message: 'Quote request email delivery is not configured yet.' }, 503);
    }
    const response = await currentWorker.fetch(request, env);
    if (url.pathname === '/' || url.pathname === '/index.html') return addQuoteAndQuantityUi(response);
    return response;
  }
};
