import core from "./worker-clean.js";

export default {
  async fetch(request, env, ctx) {
    const response = await core.fetch(request, env, ctx);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;

    const html = await response.text();
    const updatedHtml = html
      .replace(
        "</head>",
        `<style>
          body{padding-top:12px!important}
          header{padding-top:32px!important}
          .live-box .live-dot{animation:livePulse 1.2s ease-in-out infinite!important;transform-origin:center;will-change:transform,opacity,box-shadow}
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
            document.addEventListener('click', event => {
              const button = event.target.closest('button');
              if (button && /official quote/i.test(button.textContent || '')) setTimeout(cleanQuoteSummary, 0);
            });
            new MutationObserver(cleanQuoteSummary).observe(document.documentElement, {subtree:true, childList:true, characterData:true});
            cleanQuoteSummary();
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
