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
          .live-box .live-dot{animation:livePulse 1.8s ease-in-out infinite!important}
          @keyframes livePulse{0%,100%{transform:scale(1);opacity:1;box-shadow:0 0 0 4px #E8F6EC}50%{transform:scale(1.15);opacity:.72;box-shadow:0 0 0 6px #E8F6EC}}
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
