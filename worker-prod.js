import core from "./worker-clean.js";
import { estimateInternationalShipping } from "./shipping-rates.js";

export default {
  async fetch(request, env, ctx) {
    let response = await core.fetch(request, env, ctx);

    // Rebuild the international-shipping part of the estimate using
    // destination + product weight instead of the old generic country range.
    // Keep the core worker responsible for product extraction, UK delivery,
    // service fee and tax-profile lookup.
    if (new URL(request.url).pathname === "/api/product" &&
        (response.headers.get("content-type") || "").includes("application/json")) {
      try {
        const data = await response.clone().json();
        if (response.ok && data?.success && data?.product) {
          const url = new URL(request.url);
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
                data.importTax = {
                  ...data.importTax,
                  status: "indicative",
                  low: Math.round(customsLow * rateMin * 100) / 100,
                  high: Math.round(customsHigh * rateMax * 100) / 100
                };
              }

              const taxLow = Number(data.importTax?.low) || 0;
              const taxHigh = Number(data.importTax?.high) || 0;
              data.total = {
                ...data.total,
                status: data.unresolved?.length ? "partial" : "estimated",
                low: Math.round((productAmount + fee + uk + shipping.low + taxLow) * 100) / 100,
                high: Math.round((productAmount + fee + uk + shipping.high + taxHigh) * 100) / 100,
                quantity
              };
            }

            // A carrier-backed rate is now resolved; only the retailer -> UK
            // leg can remain unresolved at this stage.
            if (Array.isArray(data.unresolved)) {
              data.unresolved = data.unresolved.filter(item => item !== "UK → destination shipping");
            }
            response = new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          } else {
            // No reliable product weight means we do not invent a shipping price.
            // This is deliberately preferable to the old generic £28–£55 fallback.
            data.destinationShipping = null;
            data.total = {
              ...data.total,
              status: "partial",
              low: null,
              high: null,
              quantity
            };
            if (!Array.isArray(data.unresolved)) data.unresolved = [];
            if (!data.unresolved.includes("UK → destination shipping")) data.unresolved.push("UK → destination shipping");
            data.importTax = {
              ...data.importTax,
              status: "unknown",
              low: null,
              high: null,
              basis: "We could not establish a reliable product weight, so international postage is shown as To confirm rather than guessed."
            };
            response = new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          }
        }
      } catch {
        // Leave the core response untouched if the shipping overlay cannot run.
      }
    }

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
              if (firstLabel) firstLabel.textContent = "Product Price (" + quantity + " × quantity)";

              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                if (/undefined\\s+\\d+\\s+identical\\s+items/i.test(node.nodeValue || '')) {
                  node.nodeValue = (node.nodeValue || '').replace(/undefined\\s+(\\d+)\\s+identical\\s+items/gi, '$1 identical items');
                }
              }
            };

            const runEstimateCleanup = () => {
              setTimeout(cleanEstimateQuantity, 100);
              setTimeout(cleanEstimateQuantity, 500);
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