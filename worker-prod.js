import core from "./worker-v6.js";
import { getNews, newsResponse, newsErrorResponse } from "./news-feed.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=UTF-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  }
});

function cleanText(value, max = 4000) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}

async function sendResendEmail(env, { to, subject, text, replyTo }) {
  const key = env?.RESEND_API_KEY;
  if (!key) return { ok: false, status: 503 };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        from: "Get It, Send It <hello@getitsendit.com>",
        to: [to],
        subject,
        text,
        ...(replyTo ? { reply_to: [replyTo] } : {})
      })
    });
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch {
    return { ok: false, status: 502 };
  }
}

function withDestination(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/product" || request.method !== "GET") return request;
  const destination = (url.searchParams.get("destination") || url.searchParams.get("country") || "").toUpperCase().trim();
  if (destination && !url.searchParams.get("destination")) url.searchParams.set("destination", destination);
  return new Request(url.toString(), request);
}

function injectUi(html) {
  const styles = `<style>
body{padding-top:6px!important}header{padding-top:32px!important}
.gis-live-dot{width:9px!important;height:9px!important;border-radius:50%!important;background:#35a55b!important;display:inline-block!important;animation:gisLivePulse 1.2s ease-in-out infinite!important;transform-origin:center!important;will-change:transform,opacity,box-shadow!important}
@keyframes gisLivePulse{0%,100%{transform:scale(.68);opacity:.35;box-shadow:0 0 0 0 rgba(53,165,91,0)}50%{transform:scale(1.25);opacity:1;box-shadow:0 0 0 7px rgba(232,246,236,.95)}}
.estimate-feedback{display:none;margin-top:14px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:var(--shadow)}.estimate-feedback.gis-show{display:block}.estimate-feedback-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:850;color:var(--orange);margin-bottom:9px}.estimate-feedback-question{font:700 20px/1.15 var(--serif);color:var(--cobalt);margin-bottom:12px}.feedback-actions{display:flex;gap:10px}.feedback-btn{flex:1;border:1px solid #CFC9BC;border-radius:10px;background:#fff;padding:10px 12px;color:var(--cobalt);font-weight:800;cursor:pointer}.feedback-btn.yes{color:#17733C}.feedback-btn.no{color:#9C421D}.feedback-reasons{display:none;margin-top:12px}.feedback-reasons.gis-show{display:block}.feedback-reasons p{font-size:12px;color:#68717C;margin:0 0 8px}.feedback-reason{border:0;background:none;color:var(--cobalt);font-size:12px;font-weight:800;padding:5px 8px 5px 0;cursor:pointer}.feedback-thanks{display:block;font-size:12px;color:#68717C}
</style>`;
  const script = `<script>
(() => {
  const qty = () => Math.max(1, Math.floor(Number(document.getElementById('qty')?.textContent) || 1));
  const successfulEstimate = () => {
    const result = document.getElementById('result');
    if (!result) return false;
    const text = (result.textContent || '').replace(/\\s+/g,' ').trim();
    if (/couldn't reliably read|request an official quote|calculating/i.test(text)) return false;
    return /£\\s*\\d/.test(text) || /Your estimate/i.test(text);
  };
  const cleanEstimate = () => {
    const meta=document.getElementById('meta'), breakdown=document.getElementById('breakdown');
    if(!meta||!breakdown)return;
    [...meta.querySelectorAll('.badge')].forEach(el=>{if(/^Quantity\\b/i.test(el.textContent||'')||/Quantity undefined/i.test(el.textContent||''))el.remove()});
    const label=breakdown.querySelector('div strong');
    if(label) label.textContent='Product Price ('+qty()+' × quantity)';
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT), nodes=[]; let n;
    while(n=walker.nextNode())nodes.push(n);
    nodes.forEach(t=>{t.nodeValue=(t.nodeValue||'').replace(/Quantity undefined/gi,'').replace(/undefined\\s+(\\d+)\\s+identical\\s+items/gi,'$1 identical items')});
  };
  const feedbackContext = () => ({ destination:document.getElementById('country')?.value||'', quantity:qty(), estimate:document.getElementById('range')?.textContent||'', productUrl:document.getElementById('url')?.value||'' });
  const sendFeedback = async payload => { try { return (await fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:true})).ok; } catch { return false; } };
  const ensureFeedback = () => {
    if(!successfulEstimate() || document.getElementById('estimateFeedback')) return null;
    const result=document.getElementById('result'), estimateCard=result?.closest('.estimate-card');
    if(!estimateCard) return null;
    const box=document.createElement('div'); box.id='estimateFeedback'; box.className='estimate-feedback gis-show';
    box.innerHTML='<div class="estimate-feedback-label">Your feedback</div><div class="estimate-feedback-question">Was this estimate helpful?</div><div class="feedback-actions"><button type="button" class="feedback-btn yes" data-feedback="yes">👍 Yes</button><button type="button" class="feedback-btn no" data-feedback="no">👎 No</button></div><div class="feedback-reasons"><p>What seemed wrong?</p><button type="button" class="feedback-reason" data-reason="shipping">Shipping</button><button type="button" class="feedback-reason" data-reason="product">Product price</button><button type="button" class="feedback-reason" data-reason="tax">Tax</button><button type="button" class="feedback-reason" data-reason="other">Something else</button></div>';
    estimateCard.parentElement.insertBefore(box,estimateCard.nextSibling);
    box.addEventListener('click',async e=>{const b=e.target.closest('[data-feedback],[data-reason]');if(!b)return;if(b.dataset.feedback==='no')box.querySelector('.feedback-reasons').classList.add('gis-show');if(b.dataset.feedback==='yes'||b.dataset.reason){const p=feedbackContext();p.feedback=b.dataset.feedback||'no';if(b.dataset.reason)p.reason=b.dataset.reason;await sendFeedback(p);box.querySelector('.feedback-actions').innerHTML='<div class="feedback-thanks">Thanks — that helps us improve the estimator.</div>';box.querySelector('.feedback-reasons').classList.remove('gis-show')}});
    return box;
  };
  const animateOriginalDot = () => {
    const matches=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').trim()==='No new updates today');
    matches.forEach(e=>{
      let dot=e.parentElement?.querySelector('.live-dot, .live-dot-static, span, i');
      if(!dot && e.previousElementSibling) dot=e.previousElementSibling;
      if(dot && dot!==e){dot.classList.add('gis-live-dot');}
    });
  };
  const observe = new MutationObserver(() => { cleanEstimate(); animateOriginalDot(); if(successfulEstimate()) ensureFeedback(); });
  observe.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(/estimate/i.test(b.textContent||'')){setTimeout(()=>{cleanEstimate(); if(successfulEstimate()) ensureFeedback();},250);setTimeout(()=>{cleanEstimate(); if(successfulEstimate()) ensureFeedback();},900);}});
  cleanEstimate(); animateOriginalDot(); if(successfulEstimate()) ensureFeedback();
})();
</script>`;
  return html.replace('</head>',styles+'</head>').replace('</body>',script+'</body>');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/news") {
      try { return newsResponse(await getNews()); } catch { return newsErrorResponse(); }
    }

    if (request.method === "POST" && url.pathname === "/api/feedback") {
      try {
        const body = await request.json();
        const feedback = cleanText(body?.feedback, 40);
        if (!feedback) return json({ success:false, error:"Missing feedback." },400);
        const reason = cleanText(body?.reason, 80);
        const text = [
          "Get It, Send It — estimate feedback", "",
          `Feedback: ${feedback}`,
          reason ? `Reason: ${reason}` : null,
          `Destination: ${cleanText(body?.destination,100)||"Not supplied"}`,
          `Quantity: ${Math.max(1,Math.min(99,Math.floor(Number(body?.quantity)||1)))}`,
          `Estimate: ${cleanText(body?.estimate,120)||"Not supplied"}`,
          cleanText(body?.productUrl,1000) ? `Product URL: ${cleanText(body?.productUrl,1000)}` : null,
          `Received: ${new Date().toISOString()}`
        ].filter(Boolean).join("\n");
        const sent=await sendResendEmail(env,{to:"feedback@getitsendit.com",subject:reason?`Estimate feedback — ${reason}`:`Estimate feedback — ${feedback}`,text});
        return sent.ok?json({success:true}):json({success:false,error:"Unable to send feedback."},502);
      } catch { return json({success:false,error:"Invalid feedback request."},400); }
    }

    if (request.method === "POST" && url.pathname === "/api/quote") {
      try {
        const body=await request.json();
        const email=cleanText(body?.email,320), productUrl=cleanText(body?.productUrl,1000);
        if(!email||!productUrl)return json({success:false,error:"Please provide an email address and product link."},400);
        const text=[
          "Get It, Send It — official quote request", "",
          `Name: ${cleanText(body?.name,160)||"Not supplied"}`,
          `Customer email: ${email}`,
          `Destination: ${cleanText(body?.destination,100)||"Not supplied"}`,
          `Quantity: ${Math.max(1,Math.min(99,Math.floor(Number(body?.quantity)||1)))}`,
          `Planning estimate: ${cleanText(body?.estimate,120)||"Not supplied"}`,
          `Product URL: ${productUrl}`, "", "Customer message:",
          cleanText(body?.message,4000)||"No additional message supplied.", "",
          `Received: ${new Date().toISOString()}`
        ].join("\n");
        const sent=await sendResendEmail(env,{to:"quote@getitsendit.com",subject:`Official quote request — ${cleanText(body?.destination,100)||"destination not specified"}`,text,replyTo:email});
        return sent.ok?json({success:true}):json({success:false,error:"Unable to send quote request."},502);
      } catch { return json({success:false,error:"Invalid quote request."},400); }
    }

    if (url.pathname === "/api/product" && request.method === "GET") {
      return core.fetch(withDestination(request), env, ctx);
    }

    let response = await core.fetch(request, env, ctx);
    if (response.status === 404 && env.ASSETS) response = await env.ASSETS.fetch(request);
    const contentType=response.headers.get("content-type")||"";
    if(!contentType.includes("text/html"))return response;
    const html=await response.text();
    const headers=new Headers(response.headers); headers.delete("content-length");
    return new Response(injectUi(html),{status:response.status,statusText:response.statusText,headers});
  }
};