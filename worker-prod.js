import core from "./worker-clean.js";

export default {
  async fetch(request, env, ctx) {
    const response = await core.fetch(request, env, ctx);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;

    return new HTMLRewriter()
      .on("head", {
        element(element) {
          element.append(
            `<style>body{padding-top:12px!important}header{padding-top:32px!important}</style>`,
            { html: true }
          );
        }
      })
      .on("script", {
        text(text) {
          const chunk = text.text;
          if (!chunk.includes("const modal=document.getElementById('quoteModal')")) return;
          text.replace(
            chunk.replace(
              "document.getElementById('quoteSummary').innerHTML='<strong>'+quantity+' identical item'+(quantity===1?'':'s')+'</strong> · '+(country.options[country.selectedIndex]?.text||'Destination')+'<br>'+document.getElementById('url').value;modal.classList.add('show')",
              "document.getElementById('quoteSummary').innerHTML='<strong>YOUR REQUEST</strong><br>'+quantity+' identical item'+(quantity===1?'':'s')+' · '+(country.options[country.selectedIndex]?.text||'Destination')+'<br><span style=\"display:block;margin-top:6px\">Product details will be verified from the link you provided.</span>';modal.classList.add('show')"
            ),
            true
          );
        }
      })
      .transform(response);
  }
};
