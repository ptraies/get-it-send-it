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
      .transform(response);
  }
};
