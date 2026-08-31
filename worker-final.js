import app from "./worker-prod.js";

function injectFinalUi(html) {
  const style = `<style>
.live-box .live-dot{display:inline-block!important;width:9px!important;height:9px!important;border-radius:50%!important;background:#35A55B!important;box-shadow:0 0 0 0 rgba(53,165,91,0)!important;animation:gisLivePulse 1.2s ease-in-out infinite!important;transform-origin:center!important;will-change:transform,opacity,box-shadow!important}
@keyframes gisLivePulse{0%,100%{transform:scale(.72);opacity:.42;box-shadow:0 0 0 0 rgba(232,246,236,0)}50%{transform:scale(1.18);opacity:1;box-shadow:0 0 0 6px rgba(232,246,236,.9)}}
.gis-feedback{margin-top:18px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--paper);box-shadow:var(--shadow)}
.gis-feedback-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:850;color:var(--orange);margin-bottom:8px}.gis-feedback-question{font:700 20px/1.15 var(--serif);color:var(--cobalt);margin-bottom:12px}.gis-feedback-actions{display:flex;gap:10px}.gis-feedback-btn{flex:1;border:1px solid #CFC9BC;border-radius:10px;background:#fff;padding:10px 12px;font-weight:800;cursor:pointer}.gis-feedback-btn.yes{color:#17733C}.gis-feedback-btn.no{color:#9C421D}.gis-feedback-reasons{display:none;margin-top:11px}.gis-feedback-reasons.show{display:block}.gis-feedback-reasons p{font-size:12px;color:#68717C;margin:0 0 6px}.gis-feedback-reason{border:0;background:none;color:var(--cobalt);font-size:12px;font-weight:800;padding:5px 10px 5px 0;cursor:pointer}.gis-feedback-thanks{display:none;margin-top:9px;font-size:12px;color:#68717C}.gis-feedback-thanks.show{display:block}
</style>`;
  const script = `<script>
(() => {
  const feedback = document.getElementById('gisFeedback');
  if (!feedback) return;
  const qty = () => Math.max(1, Math.floor(Number(document.getElementById('qty')?.textContent) || 1));
  const send = async payload => { try { const r = await fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:true}); return r.ok; } catch { return false; } };
  feedback.addEventListener('click', async e => {
    const b = e.target.closest('[data-feedback],[data-reason]');
    if (!b) return;
    if (b.dataset.feedback === 'no') { feedback.querySelector('.gis-feedback-reasons').classList.add('show'); return; }
    const payload = { feedback:b.dataset.feedback || 'no', reason:b.dataset.reason || '', destination:document.getElementById('country')?.value || '', quantity:qty(), estimate:document.getElementById('range')?.textContent || '', productUrl:document.getElementById('url')?.value || '' };
    await send(payload);
    feedback.querySelector('.gis-feedback-actions').innerHTML='<div class="gis-feedback-thanks show">Thanks — that helps us improve the estimator.</div>';
    feedback.querySelector('.gis-feedback-reasons').classList.remove('show');
  });
})();
</script>`;
  const feedback = `<div id="gisFeedback" class="gis-feedback"><div class="gis-feedback-label">Your feedback</div><div class="gis-feedback-question">Was this estimate helpful?</div><div class="gis-feedback-actions"><button type="button" class="gis-feedback-btn yes" data-feedback="yes">👍 Yes</button><button type="button" class="gis-feedback-btn no" data-feedback="no">👎 No</button></div><div class="gis-feedback-reasons"><p>What seemed wrong?</p><button type="button" class="gis-feedback-reason" data-reason="shipping">Shipping</button><button type="button" class="gis-feedback-reason" data-reason="product">Product price</button><button type="button" class="gis-feedback-reason" data-reason="tax">Tax</button><button type="button" class="gis-feedback-reason" data-reason="other">Something else</button></div></div>`;
  let updated = html.replace('</head>', style + '</head>');
  if (!updated.includes('id="gisFeedback"')) {
    const marker = '<div class="news-source">';
    if (updated.includes(marker)) updated = updated.replace(marker, feedback + marker);
    else updated = updated.replace('</aside>', feedback + '</aside>');
  }
  return updated.replace('</body>', script + '</body>');
}

export default {
  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return response;
    const html = await response.text();
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(injectFinalUi(html), { status:response.status, statusText:response.statusText, headers });
  }
};
