import core from "./worker-clean.js";
import { estimateInternationalShipping } from "./shipping-rates.js";
import { getNews, newsResponse, newsErrorResponse } from "./news-feed.js";

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/api/news") {
      try { return newsResponse(await getNews()); } catch { return newsErrorResponse(); }
    }

    let response = await core.fetch(request, env, ctx);
    if (requestUrl.pathname === "/api/product" && (response.headers.get("content-type") || "").includes("application/json")) {
      try {
        const data = await response.clone().json();
        if (response.ok && data?.success && data?.product) {
          const destination = String(requestUrl.searchParams.get("country") || "").toUpperCase();
          const quantity = Math.max(1, Math.min(99, Math.floor(Number(requestUrl.searchParams.get("quantity")) || 1)));
          const shipping = estimateInternationalShipping(destination, quantity, data.product, requestUrl.searchParams.get("url") || "");
          const productAmount = Number(data.product?.amount ?? data.product?.priceGbp ?? 0);
          const fee = Number(data.serviceFee?.amount ?? 0);
          const uk = data.ukShipping?.status === "confirmed" ? Number(data.ukShipping.amount) || 0 : 0;
          const rateMin = Number(data.importTax?.rateMin);
          const rateMax = Number(data.importTax?.rateMax);
          if (shipping) {
            data.destinationShipping = shipping;
            const customsLow = productAmount + uk + shipping.low;
            const customsHigh = productAmount + uk + shipping.high;
            if (Number.isFinite(rateMin) && Number.isFinite(rateMax)) data.importTax = { ...data.importTax, status: "indicative", low: Math.round(customsLow * rateMin * 100) / 100, high: Math.round(customsHigh * rateMax * 100) / 100 };
            const taxLow = Number(data.importTax?.low) || 0;
            const taxHigh = Number(data.importTax?.high) || 0;
            data.total = { ...data.total, status: data.unresolved?.length ? "partial" : "estimated", low: Math.round((productAmount + fee + uk + shipping.low + taxLow) * 100) / 100, high: Math.round((productAmount + fee + uk + shipping.high + taxHigh) * 100) / 100, quantity };
          } else {
            const ranges = { CN:[11.40,13.15],US:[12.17,14.25],CA:[14.44,14.44],JP:[12.45,15.70],AU:[12.35,15.85],NZ:[15.30,16.30],IN:[12.50,15.80],BR:[12.30,15.60],DE:[8.15,9.40],FR:[9.90,10.85],ES:[9.60,10.20],IT:[9.85,10.70],NL:[9.20,10.10],BE:[9.65,10.60] };
            const [lowShip, highShip] = ranges[destination] || [14.40,18.15];
            const taxLow = Number.isFinite(rateMin) ? (productAmount + uk + lowShip) * rateMin : 0;
            const taxHigh = Number.isFinite(rateMax) ? (productAmount + uk + highShip) * rateMax : 0;
            data.destinationShipping = { status:"estimated", amount:null, low:lowShip, high:highShip, currency:"GBP", carrier:"Royal Mail", service:"International Tracked", pricing:"planning range", quantity, weightAssumption:"unknown; small-parcel planning band", basis:"Planning range based on current Royal Mail International Tracked pricing for a small parcel. Product weight could not be established reliably, so this is deliberately a range rather than a precise quote. Actual packed weight, dimensions and carrier service may change the final postage charge." };
            if (Number.isFinite(rateMin) && Number.isFinite(rateMax)) data.importTax = { ...data.importTax, status:"indicative", low:Math.round(taxLow*100)/100, high:Math.round(taxHigh*100)/100 };
            data.total = { ...data.total, status:data.unresolved?.length ? "partial" : "estimated", low:Math.round((productAmount+fee+uk+lowShip+taxLow)*100)/100, high:Math.round((productAmount+fee+uk+highShip+taxHigh)*100)/100, quantity };
          }
          if (Array.isArray(data.unresolved)) data.unresolved = data.unresolved.filter(item => item !== "UK → destination shipping");
          response = new Response(JSON.stringify(data), { status:response.status, statusText:response.statusText, headers:response.headers });
        }
      } catch {}
    }

    if (response.status === 404 && env.ASSETS) response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;
    const html = await response.text();
    const updatedHtml = html
      .replace("</head>", `<style>
body{padding-top:12px!important}header{padding-top:32px!important}
.live-box .live-dot{display:inline-block!important;animation:livePulse 1.2s ease-in-out infinite!important;transform-origin:center;will-change:transform,opacity,box-shadow}
@keyframes livePulse{0%,100%{transform:scale(.68);opacity:.35;box-shadow:0 0 0 0 rgba(53,165,91,0)}50%{transform:scale(1.25);opacity:1;box-shadow:0 0 0 7px rgba(232,246,236,.95)}}
.news-live-wrap{margin-top:8px}.news-live-status{display:flex;align-items:center;gap:8px;color:#16458f;font-weight:800}.news-live-dot{width:9px;height:9px;border-radius:50%;background:#35a55b;display:inline-block;animation:livePulse 1.2s ease-in-out infinite}.news-source-line{margin-top:6px;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.08em;font-weight:700}.news-source-line a{color:#777;text-decoration:underline;text-underline-offset:2px}.news-item a:hover{text-decoration:underline!important}.news-feed-footer{margin-top:18px;padding-top:14px;border-top:1px solid #ddd;font-size:12px;line-height:1.5;color:#707984}.news-feed-footer strong{color:#3f4a57}
</style></head>`)
      .replace("</body>", `<script>
(() => {
  const cleanQuoteSummary=()=>{const s=document.getElementById('quoteSummary');if(!s||!/https?:\\/\\//i.test(s.textContent||''))return;const b=(s.textContent||'').split(/https?:\\/\\//i)[0].trim();s.textContent='';const h=document.createElement('strong');h.textContent='YOUR REQUEST';s.append(h,document.createElement('br'),document.createTextNode(b));const n=document.createElement('span');n.style.cssText='display:block;margin-top:6px';n.textContent='Product details will be verified from the link you provided.';s.appendChild(n)};
  const cleanEstimateQuantity=()=>{const m=document.getElementById('meta'),b=document.getElementById('breakdown');if(!m||!b)return;const q=Math.max(1,Math.floor(Number(document.getElementById('qty')?.textContent)||1));Array.from(m.querySelectorAll('.badge')).forEach(x=>{if(/^Quantity\\b/i.test((x.textContent||'').trim())||/Quantity undefined/i.test(x.textContent||''))x.remove()});const label=b.querySelector('div strong');if(label)label.textContent='Product Price ('+q+' × quantity)';const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),a=[];let n;while(n=w.nextNode())a.push(n);a.forEach(t=>{const x=t.nodeValue||'';if(/Quantity undefined/i.test(x))t.nodeValue=x.replace(/Quantity undefined/gi,'');if(/undefined\\s+(\\d+)\\s+identical\\s+items/i.test(x))t.nodeValue=x.replace(/undefined\\s+(\\d+)\\s+identical\\s+items/gi,'$1 identical items')})};
  const loadLiveNews=async()=>{try{const r=await fetch('/api/news',{cache:'no-store'});if(!r.ok)throw Error();const d=await r.json();if(!d?.success||!Array.isArray(d.items)||!d.items.length)return;const heading=Array.from(document.querySelectorAll('h2,h3,h4')).find(e=>/Recent changes/i.test(e.textContent||''));if(!heading)return;const section=heading.parentElement;if(!section)return;Array.from(section.querySelectorAll('.news-item,.news-live-wrap,.news-feed-footer')).forEach(e=>e.remove());
    const live=document.createElement('div');live.className='news-live-wrap';live.innerHTML='<div class="news-live-status"><span class="news-live-dot"></span>Live tax & import updates</div>';section.insertBefore(live,heading.nextSibling);
    const frag=document.createDocumentFragment();d.items.slice(0,5).forEach(item=>{const article=document.createElement('article');article.className='news-item';article.style.cssText='padding:14px 0;border-bottom:1px dashed #ddd';const title=document.createElement('a');title.href=item.link;title.target='_blank';title.rel='noopener noreferrer';title.textContent=item.title;title.style.cssText='display:block;color:#16458f;font-weight:800;font-size:16px;text-decoration:none;line-height:1.25';const meta=document.createElement('div');meta.className='news-source-line';meta.textContent=(item.source||'Source')+(item.date?' · '+new Date(item.date).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}):'');const text=document.createElement('div');text.textContent=item.description||'Tax, customs or import development relevant to cross-border buying.';text.style.cssText='margin-top:7px;font-size:13px;line-height:1.45;color:#68717c';article.append(title,meta,text);frag.appendChild(article)});section.insertBefore(frag,live.nextSibling);
    const footer=document.createElement('div');footer.className='news-feed-footer';footer.innerHTML='<strong>Live sources:</strong> PwC · GOV.UK · KPMG. Stories are checked automatically and linked to the original publisher. This is a planning feed, not legal or customs advice.';section.appendChild(footer);
  }catch{}};
  const runEstimateCleanup=()=>{setTimeout(cleanEstimateQuantity,100);setTimeout(cleanEstimateQuantity,600);setTimeout(cleanEstimateQuantity,1200)};
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const t=b.textContent||'';if(/official quote/i.test(t))setTimeout(cleanQuoteSummary,100);if(/estimate/i.test(t))runEstimateCleanup()});
  cleanQuoteSummary();cleanEstimateQuantity();loadLiveNews();
})();
</script></body>`);
    const headers=new Headers(response.headers);headers.delete("content-length");return new Response(updatedHtml,{status:response.status,statusText:response.statusText,headers});
  }
};