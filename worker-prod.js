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
          .live-dot{animation:livePulse 1.8s ease-in-out infinite}
          @keyframes livePulse{0%,100%{transform:scale(1);opacity:1;box-shadow:0 0 0 4px #E8F6EC}50%{transform:scale(1.15);opacity:.72;box-shadow:0 0 0 6px #E8F6EC}}
        </style></head>`
      )
      .replace(
        /document\.getElementById\('quoteSummary'\)\.innerHTML=[\s\S]*?;modal\.classList\.add\('show'\)/,
        "document.getElementById('quoteSummary').innerHTML='<strong>YOUR REQUEST</strong><br>'+quantity+' identical item'+(quantity===1?'':'s')+' · '+(country.options[country.selectedIndex]?.text||'Destination')+'<br><span style=\"display:block;margin-top:6px\">Product details will be verified from the link you provided.</span>';modal.classList.add('show')"
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
