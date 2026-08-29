import core from "./worker-clean.js";

export default {
  async fetch(request, env, ctx) {
    let response = await core.fetch(request, env, ctx);

    // When run_worker_first is enabled, static assets no longer get an
    // automatic chance to handle requests. Fall back to the ASSETS binding
    // when the application worker does not have a route for the request.
    if (response.status === 404 && env.ASSETS) {
      response = await env.ASSETS.fetch(request);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;

    const html = await response.text();
    const updatedHtml = html
      .replace(
        "</head>",
        `<style>
          body{padding-top:12px!important}
          header{padding-top:32px!important}
          .live-box .live-dot{display:inline-block!important;animation:livePulse 1.2s ease-in-out infinite!important;transform-origin:center;will-change:transform,opacity,box-shadow}
          @keyframes livePulse{0%,100%{transform:scale(.68);opacity:.35;box-shadow:0 0 0 0 rgba(53,165,91,0)}50%{transform:scale(1.25);opacity:1;box-shadow:0 0 0 7px rgba(232,246,236,.95)}}
        </style></head>`
      )
      .replace(
        "</body>",
        `<script>
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

              const badges = Array.from(meta.querySelectorAll('.badge'));
              const quantityBadge = badges.find(el => /^Quantity\\b/i.test((el.textContent || '').trim()));
              const badgeText = quantityBadge?.textContent || '';
              const bodyText = document.body?.textContent || '';
              const match = badgeText.match(/\\d+/) || bodyText.match(/(\\d+)\\s+identical\\s+items/i);
              if (!match) return;

              const quantity = match[1] || match[0];
              if (quantityBadge) quantityBadge.remove();

              const firstRow = breakdown.querySelector('div');
              const firstLabel = firstRow?.querySelector('strong');
              if (firstLabel) firstLabel.textContent = `Product Price (${quantity} × quantity)`;

              const allTextNodes = [];
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) allTextNodes.push(node);
              for (const textNode of allTextNodes) {
                if (/undefined\\s+\\d+\\s+identical\\s+items/i.test(textNode.nodeValue || '')) {
                  textNode.nodeValue = (textNode.nodeValue || '').replace(/undefined\\s+(\\d+)\\s+identical\\s+items/gi, '$1 identical items');
                }
              }
            };

            document.addEventListener('click', event => {
              const button = event.target.closest('button');
              if (button && /official quote/i.test(button.textContent || '')) setTimeout(cleanQuoteSummary, 0);
            });
            new MutationObserver(() => {
              cleanQuoteSummary();
              cleanEstimateQuantity();
            }).observe(document.documentElement, {subtree:true, childList:true, characterData:true});
            cleanQuoteSummary();
            cleanEstimateQuantity();
          })();
        </script></body>`
      );

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(updatedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};