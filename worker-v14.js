import currentWorker from "./worker-v12.js";

const MIN_FEE = 15;
const FEE_RATE = 0.15;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function json(data, status, headers) {
  const h = new Headers(headers || {});
  h.delete("content-length"); h.set("content-type", "application/json; charset=UTF-8"); h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

function applyQuantity(data, quantity) {
  if (!data || !data.success || !data.product) return data;
  const q = Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1)));
  const unit = n(data.product.priceGbp ?? data.product.price);
  if (unit === null) return data;
  const productPrice = Math.round(unit * q * 100) / 100;
  const fee = Math.round(Math.max(MIN_FEE, productPrice * FEE_RATE) * 100) / 100;
  const baseLow = n(data.destinationShipping?.low);
  const baseHigh = n(data.destinationShipping?.high);
  const unitWeight = n(data.shippingInput?.weightKg);
  let lowShip = baseLow, highShip = baseHigh;
  let shipping = data.destinationShipping;
  if (baseLow !== null && baseHigh !== null && q > 1) {
    let m = 1 + Math.log2(q) * 0.72;
    if (unitWeight !== null) {
      if (q === 2) m = 1.55; else if (q === 3) m = 1.95; else if (q <= 5) m = 2.35; else if (q <= 10) m = 3.2; else m = 4.5;
    }
    lowShip = Math.round(baseLow * Math.min(4.5, m) * 100) / 100;
    highShip = Math.round(baseHigh * Math.min(4.5, m) * 100) / 100;
    shipping = { ...shipping, low: lowShip, high: highShip, quantity: q, estimatedShipmentWeightKg: unitWeight === null ? null : Math.round(unitWeight * q * 100) / 100, basis: (shipping.basis || "") + " Multiple identical units are treated as one combined shipment where practical; shipping is not assumed to multiply one-for-one." };
  }
  const uk = data.ukShipping?.status === "confirmed" ? (n(data.ukShipping.amount) || 0) : 0;
  const rMin = n(data.importTax?.rateMin), rMax = n(data.importTax?.rateMax);
  let tax = data.importTax, lowTax = 0, highTax = 0;
  if (data.importTax?.status === "indicative" && lowShip !== null && highShip !== null && rMin !== null && rMax !== null) {
    lowTax = Math.round((productPrice + uk + lowShip) * rMin * 100) / 100;
    highTax = Math.round((productPrice + uk + highShip) * rMax * 100) / 100;
    tax = { ...tax, low: lowTax, high: highTax };
  }
  const total = lowShip === null || highShip === null ? data.total : { ...(data.total || {}), low: Math.round((productPrice + uk + fee + lowShip + lowTax) * 100) / 100, high: Math.round((productPrice + uk + fee + highShip + highTax) * 100) / 100, currency: "GBP", quantity: q };
  return { ...data, quantity: q, product: { ...data.product, unitPriceGbp: unit, priceGbp: productPrice, price: productPrice, quantity: q }, serviceFee: { status: "confirmed", amount: fee, rate: FEE_RATE, minimum: MIN_FEE, basis: "The greater of £15 or 15% of the product price only. Shipping and destination taxes are excluded." }, destinationShipping: shipping, importTax: tax, total, quoteContext: { unitPriceGbp: unit, quantity: q } };
}

function injectUi(response) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;
  return new HTMLRewriter().on("body", { element(el) {
    el.append(`<script>
(function(){
 if(window.__gisV14)return; window.__gisV14=true;
 var q=1,last=null;
 function add(){
  if(document.getElementById('gisQuantity'))return;
  var country=document.getElementById('country'); if(!country||!country.parentElement)return;
  var w=document.createElement('div'); w.id='gisQuantity'; w.style.cssText='margin:14px 0';
  w.innerHTML='<div class="field-label">Quantity</div><div style="display:flex;align-items:center;justify-content:space-between;border:1px solid #CFC9BC;border-radius:13px;background:#fff;padding:6px 8px 6px 15px"><span>How many would you like?</span><span style="display:flex;align-items:center;gap:10px"><button type="button" id="gisQM" style="width:34px;height:34px;border:1px solid #D5D0C5;border-radius:10px;background:#F7F3EA">−</button><b id="gisQN">1</b><button type="button" id="gisQP" style="width:34px;height:34px;border:1px solid #D5D0C5;border-radius:10px;background:#F7F3EA">+</button></span></div>';
  country.parentElement.parentElement.insertBefore(w,country.parentElement);
  function set(v){q=Math.max(1,Math.min(99,v));document.getElementById('gisQN').textContent=q;if(last&&typeof window.gisRefresh==='function')window.gisRefresh(q)}
  document.getElementById('gisQM').onclick=function(){set(q-1)};document.getElementById('gisQP').onclick=function(){set(q+1)};
 }
 function observe(){add();var r=document.getElementById('result');if(r&&!document.getElementById('gisResultExtra')){var x=document.createElement('div');x.id='gisResultExtra';r.appendChild(x)} }
 document.addEventListener('DOMContentLoaded',observe);setTimeout(observe,300);
 window.gisRefresh=function(qty){var r=document.getElementById('result');if(!r)return;var note=document.getElementById('gisQuantityNote');if(!note){note=document.createElement('div');note.id='gisQuantityNote';r.appendChild(note)}note.innerHTML='<div style="margin-top:12px;font-size:11px;color:#68717C">Quantity: <strong>'+qty+'</strong>. The estimate will use the combined product value and shipment where applicable.</div>';};
})();
</script>`, {html:true});
  }}).transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/product" && request.method === "GET") {
      const response = await currentWorker.fetch(request, env);
      let data = null; try { data = await response.clone().json(); } catch {}
      if (data?.success) return json(applyQuantity(data, url.searchParams.get("quantity")), response.status, response.headers);
      return response;
    }
    const response = await currentWorker.fetch(request, env);
    return (url.pathname === "/" || url.pathname === "/index.html") ? injectUi(response) : response;
  }
};
