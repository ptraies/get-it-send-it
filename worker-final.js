import app from "./worker-prod.js";

const STYLE = `<style>
.live-box .live-dot{display:inline-block!important;width:9px!important;height:9px!important;border-radius:50%!important;background:#35A55B!important;box-shadow:0 0 0 0 rgba(53,165,91,0)!important;animation:gisLivePulse 1.2s ease-in-out infinite!important;transform-origin:center!important;will-change:transform,opacity,box-shadow!important}
@keyframes gisLivePulse{0%,100%{transform:scale(.72);opacity:.42;box-shadow:0 0 0 0 rgba(53,165,91,0)}50%{transform:scale(1.18);opacity:1;box-shadow:0 0 0 6px rgba(232,246,236,.9)}}
.gis-feedback{display:none;margin-top:18px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--paper);box-shadow:var(--shadow)}
.gis-feedback.gis-show{display:block}.gis-feedback-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:850;color:var(--orange);margin-bottom:8px}.gis-feedback-question{font:700 20px/1.15 var(--serif);color:var(--cobalt);margin-bottom:12px}.gis-feedback-actions{display:flex;gap:10px}.gis-feedback-btn{flex:1;border:1px solid #CFC9BC;border-radius:10px;background:#fff;padding:10px 12px;font-weight:800;cursor:pointer}.gis-feedback-btn.yes{color:#17733C}.gis-feedback-btn.no{color:#9C421D}.gis-feedback-reasons{display:none;margin-top:11px}.gis-feedback-reasons.gis-show{display:block}.gis-feedback-reasons p{font-size:12px;color:#68717C;margin:0 0 6px}.gis-feedback-reason{border:0;background:none;color:var(--cobalt);font-size:12px;font-weight:800;padding:5px 10px 5px 0;cursor:pointer}.gis-feedback-thanks{display:none;margin-top:9px;font-size:12px;color:#68717C}.gis-feedback-thanks.gis-show{display:block}
</style>`;

const SCRIPT = `<script>
(() => {
  const qty = () => Math.max(1, Math.floor(Number(document.getElementById('qty')?.textContent) || 1));
  const cleanEstimate = () => {
    const meta=document.getElementById('meta');
    const breakdown=document.getElementById('breakdown');
    if(meta){
      [...meta.querySelectorAll('.badge')].forEach(el=>{
        if(/Quantity undefined/i.test(el.textContent||'')) el.remove();
        if(/^Quantity\\s+\\d+/i.test((el.textContent||'').trim())) el.textContent='Quantity '+qty();
      });
    }
    if(breakdown){
      const first=breakdown.querySelector('div strong');
      if(first) first.textContent='Product Price ('+qty()+' × quantity)';
    }
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),nodes=[];let n;
    while(n=walker.nextNode())nodes.push(n);
    nodes.forEach(t=>{t.nodeValue=(t.nodeValue||'').replace(/Quantity undefined/gi,'').replace(/undefined\\s+(\\d+)\\s+identical\\s+items/gi,'$1 identical items')});
  };
  const successfulEstimate = () => {
    const r=document.getElementById('result');
    const range=(document.getElementById('range')?.textContent||'').trim();
    return !!r && r.classList.contains('show') && /^~?£\\d/.test(range);
  };
  const feedback = () => {
    if(!successfulEstimate()) return;
    const news=document.querySelector('.news-card');
    if(!news) return;
    let box=document.getElementById('gisFeedback');
    if(!box){
      box=document.createElement('div');
      box.id='gisFeedback';
      box.className='gis-feedback';
      box.innerHTML='<div class="gis-feedback-label">Your feedback</div><div class="gis-feedback-question">Was this estimate helpful?</div><div class="gis-feedback-actions"><button type="button" class="gis-feedback-btn yes" data-feedback="yes">👍 Yes</button><button type="button" class="gis-feedback-btn no" data-feedback="no">👎 No</button></div><div class="gis-feedback-reasons"><p>What seemed wrong?</p><button type="button" class="gis-feedback-reason" data-reason="shipping">Shipping</button><button type="button" class="gis-feedback-reason" data-reason="product">Product price</button><button type="button" class="gis-feedback-reason" data-reason="tax">Tax</button><button type="button" class="gis-feedback-reason" data-reason="other">Something else</button></div><div class="gis-feedback-thanks">Thanks — that helps us improve the estimator.</div>';
      news.appendChild(box);
      box.addEventListener('click',async e=>{
        const b=e.target.closest('[data-feedback],[data-reason]');
        if(!b) return;
        if(b.dataset.feedback==='no'){box.querySelector('.gis-feedback-reasons')?.classList.add('gis-show');return;}
        const payload={feedback:b.dataset.feedback||'no',reason:b.dataset.reason||'',destination:document.getElementById('country')?.value||'',quantity:qty(),estimate:document.getElementById('range')?.textContent||'',productUrl:document.getElementById('url')?.value||''};
        try{await fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:true})}catch{}
        box.querySelector('.gis-feedback-actions').innerHTML='<div class="gis-feedback-thanks gis-show">Thanks — that helps us improve the estimator.</div>';
        box.querySelector('.gis-feedback-reasons')?.classList.remove('gis-show');
      });
    }
    box.classList.add('gis-show');
  };
  const sync=()=>{cleanEstimate();feedback()};
  const observer=new MutationObserver(sync);
  observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  document.addEventListener('click',e=>{if(e.target.closest('#estimateBtn')){setTimeout(sync,150);setTimeout(sync,700);setTimeout(sync,1400)}});
  sync();
})();
</script>`;

function injectUi(html){
  let updated=String(html||'');
  updated=updated.replace(/<div id="gisFeedback"[\s\S]*?<\/div>/i,'');
  updated=updated.replace('</head>',STYLE+'</head>');
  updated=updated.replace('</body>',SCRIPT+'</body>');
  return updated;
}

export default {
  async fetch(request, env, ctx){
    const response=await app.fetch(request,env,ctx);
    const type=response.headers.get('content-type')||'';
    if(!type.includes('text/html')) return response;
    const html=await response.text();
    const headers=new Headers(response.headers);headers.delete('content-length');
    return new Response(injectUi(html),{status:response.status,statusText:response.statusText,headers});
  }
};
