import app from "./worker-prod-fixed.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/api/product" || url.pathname === "/api/estimate")) {
      const country = url.searchParams.get("country");
      if (country && !url.searchParams.get("destination")) {
        url.searchParams.set("destination", country);
        request = new Request(url.toString(), request);
      }
    }
    return app.fetch(request, env, ctx);
  }
};