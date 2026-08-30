import core from "./worker-clean.js";
import { estimateInternationalShipping } from "./shipping-rates.js";
import { getNews, newsResponse, newsErrorResponse } from "./news-feed.js";

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);

    // Live tax/import news endpoint. The feed is sourced from publisher results
    // and filtered server-side to keep the customer-facing panel relevant.
    if (requestUrl.pathname === "/api/news") {
      try {
        const items = await getNews();
        return newsResponse(items);
      } catch {
        return newsErrorResponse();
      }
    }

    let response = await core.fetch(request, env, ctx);

    // Rebuild the international-shipping part of the estimate using
    // destination + product weight/URL evidence instead of the old generic range.
    if (requestUrl.pathname === "/api/product" &&
        (response.headers.get("content-type") || "").includes("application/json")) {
      try {
        const data = await response.clone().json();
        if (response.ok && data?.success && data?.product) {
          const url = requestUrl;
          const destination = String(url.searchParams.get("country") || "").toUpperCase();
          const quantity = Math.max(1, Math.min(99, Math.floor(Number(url.searchParams.get("quantity")) || 1)));
          const shipping = estimateInternationalShipping(destination, quantity, data.product, url.searchParams.get("url") || "");

          if (shipping) {
            data.destinationShipping = shipping;
            const productAmount = Number(data.product?.amount ?? data.product?.priceGbp ?? 0);
            const fee = Number(data.serviceFee?.amount ?? 0);
            const uk = data.ukShipping?.status === "confirmed" ? Number(data.ukShipping.amount) || 0 : 0;
            const rateMin = Number(data.importTax?.rateMin);
            const rateMax = Number(data.importTax?.rateMax);
            if (Number.isFinite(productAmount) && Number.isFinite(fee)) {
              const customsLow = productAmount + uk + shipping.low;
              const customsHigh = productAmount + uk + shipping.high;
              if (Number.isFinite(rateMin) && Number.isFinite(rateMax)) {
                data.importTax = { ...data.importTax, status: "indicative", low: Math.round(customsLow * rateMin * 100) / 100, high: Math.round(customsHigh * rateMax * 100) / 100 };
              }
              const taxLow = Number(data.importTax?.low) || 0;
              const taxHigh = Number(data.importTax?.high) || 0;
              data.total = { ...data.total, status: data.unresolved?.length ? "partial" : "estimated", low: Math.round((productAmount + fee + uk + shipping.low + taxLow) * 100) / 100, high: Math.round((productAmount + fee + uk + shipping.high + taxHigh) * 100) / 100, quantity };
            }
            if (Array.isArray(data.unresolved)) data.unresolved = data.unresolved.filter(item => item !== "UK → destination shipping");
            response = new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers: response.headers });
          } else {
            const planningRanges = {
              CN: [11.40, 13.15], US: [12.17, 14.25], CA: [14.44, 14.44], JP: [12.45, 15.70], AU: [12.35, 15.85], NZ: [15.30, 16.30],
              IN: [12.50, 15.80], BR: [12.30, 15.60], DE: [8.15, 9.40], FR: [9.90, 10.85], ES: [9.60, 10.20], IT: [9.85, 10.70], NL: [9.20, 10.10], BE: [9.65, 10.60]
            };
            const range = planningRanges[destination] || [14.40, 18.15];
            const lowShip = range[0];
            const highShip = range[1];
            const productAmount = Number(data.product?.amount ?? data.product?.priceGbp ?? 0);
            const fee = Number(data.serviceFee?.amount ?? 0);
            const uk = data.ukShipping?.status === "confirmed" ? Number(data.ukShipping.amount) || 0 : 0;
            const rateMin = Number(data.importTax?.rateMin);
            const rateMax = Number(data.importTax?.rateMax);
            const taxLow = Number.isFinite(rateMin) ? (productAmount + uk + lowShip) * rateMin : 0;
            const taxHigh = Number.isFinite(rateMax) ? (productAmount + uk + highShip) * rateMax : 0;
            data.destinationShipping = { status: "estimated", amount: null, low: lowShip, high: highShip, currency: "GBP", carrier: "Royal Mail", service: "International Tracked", pricing: "planning range", quantity, weightAssumption: "unknown; small-parcel planning band", basis: "Planning range based on current Royal Mail International Tracked pricing for a small parcel. Product weight could not be established reliably, so this is deliberately a range rather than a precise quote. Actual packed weight, dimensions and carrier service may change the final postage charge." };
            if (Number.isFinite(rateMin) && Number.isFinite(rateMax)) data.importTax = { ...data.importTax, status: "indicative", low: Math.round(taxLow * 100) / 100, high: Math.round(taxHigh * 100) / 100 };
            data.total = { ...data.total, status: data.unresolved?.length ? "partial" : "estimated", low: Math.round((productAmount + fee + uk + lowShip + taxLow) * 100) / 100, high: Math.round((productAmount + fee + uk + highShip + taxHigh) * 100) / 100, quantity };
            if (Array.isArray(data.unresolved)) data.unresolved = data.unresolved.filter(item => item !== "UK → destination shipping");
            response = new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers: response.headers });
          }
        }
      } catch {
        // Leave the core response untouched if the shipping overlay cannot run.
      }
    }

    if (response.status === 404 && env.ASSETS) response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;

    const html = await response.text();
    const updatedHtml = html
      .replace("</head>", `<style>body{padding-top:12px!important}header{padding-top:32px!important}.live-box .live-dot{display:inline-block!important;animation:livePulse 1.2s ease-in-out infinite!important;transform-origin:center;will-change:transform,opacity,box-shadow}@keyframes livePulse{0%,100%{transform:scale(.68);opacity:.35;box-shadow:0 0 0 0 rgba(53,165,91,0)}50%{transform:scale(1.25);opacity:1;box-shadow:0 0 0 7px rgba(232,246,236,.95)}}</style></head>`)
      .replace("</body>", `<script>
(() => {
  const cleanQuoteSummary = () => {
    const summary = document.getElementById('quoteSummary');
    if (!summary || !/https?:\\/\\//i.test(summary.textContent || '')) return;
    const beforeUrl = (summary.textContent || '').split(/https?:\\/\\//i)[0].trim();
    summary.textContent = '';
    const heading = document.createElement('strong');
    heading.textContent = 'YOUR REQUEST';
    summary.appendChild(heading);
    summary.appendChild(document.createElement('br'));
    summary.appendChild(document.createTextNode(beforeUrl));
    const note = document.createElement('span');
    note.style.display = 'block';
    note.style.marginTop = '6px';
    note.textContent = 'Product details will be verified from the link you provided.';
    summary.appendChild(note);
  };

  const cleanEstimateQuantity = () => {
    const meta = document.getElementById('meta');
    const breakdown = document.getElementById('breakdown');
    if (!meta || !breakdown) return;

    const qtyEl = document.getElementById('qty');
    const quantity = Math.max(1, Math.floor(Number(qtyEl?.textContent) || 1));

    for (const badge of Array.from(meta.querySelectorAll('.badge'))) {
      if (/^Quantity\\b/i.test((badge.textContent || '').trim()) || /Quantity undefined/i.test(badge.textContent || '')) badge.remove();
    }

    const firstRow = breakdown.querySelector('div');
    const firstLabel = firstRow?.querySelector('strong');
    if (firstLabel) firstLabel.textContent = 'Product Price (' + quantity + ' × quantity)';

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      if (/Quantity undefined/i.test(text)) textNode.nodeValue = text.replace(/Quantity undefined/gi, '');
      if (/undefined\\s+(\\d+)\\s+identical\\s+items/i.test(text)) textNode.nodeValue = text.replace(/undefined\\s+(\\d+)\\s+identical\\s+items/gi, '$1 identical items');
    }
  };

  const loadLiveNews = async () => {
    try {
      const response = await fetch('/api/news', { cache: 'no-store' });
      if (!response.ok) throw new Error('News request failed');
      const data = await response.json();
      if (!data?.success || !Array.isArray(data.items) || !data.items.length) return;
      const heading = Array.from(document.querySelectorAll('h2,h3,h4')).find(el => /Recent changes/i.test(el.textContent || ''));
      if (!heading) return;
      const list = heading.nextElementSibling;
      const container = list?.parentElement;
      if (!container) return;
      const oldItems = Array.from(container.children).filter(el => el !== heading && !/How we research/i.test(el.textContent || ''));
      oldItems.forEach(el => el.remove());
      data.items.slice(0, 5).forEach(item => {
        const article = document.createElement('article');
        article.className = 'news-item';
        article.style.padding = '14px 0';
        article.style.borderBottom = '1px solid #eee';
        const title = document.createElement('a');
        title.href = item.link;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
        title.textContent = item.title;
        title.style.cssText = 'display:block;color:#16458f;font-weight:800;font-size:16px;text-decoration:none;line-height:1.2';
        const meta = document.createElement('div');
        meta.textContent = `${item.source || 'Source'}${item.date ? ' · ' + new Date(item.date).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'}) : ''}`;
        meta.style.cssText = 'margin-top:6px;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.08em;font-weight:700';
        const text = document.createElement('div');
        text.textContent = item.description || 'Tax, customs or import development relevant to cross-border buying.';
        text.style.cssText = 'margin-top:7px;font-size:13px;line-height:1.45;color:#68717c';
        article.append(title, meta, text);
        heading.parentElement.insertBefore(article, heading.parentElement.querySelector('h2,h3,h4')?.nextSibling || null);
      });
    } catch {
      // Keep the existing static news panel if the live feed is unavailable.
    }
  };

  const runEstimateCleanup = () => {
    setTimeout(cleanEstimateQuantity, 100);
    setTimeout(cleanEstimateQuantity, 600);
    setTimeout(cleanEstimateQuantity, 1200);
  };

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const text = button.textContent || '';
    if (/official quote/i.test(text)) setTimeout(cleanQuoteSummary, 100);
    if (/estimate/i.test(text)) runEstimateCleanup();
  });

  cleanQuoteSummary();
  cleanEstimateQuantity();
  loadLiveNews();
})();
</script></body>`);

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(updatedHtml, { status: response.status, statusText: response.statusText, headers });
  }
};