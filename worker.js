import worker from "./worker-clean.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

async function normalize(response) {
  let data;
  try { data = await response.clone().json(); } catch { return response; }
  if (!data?.success || !data.product) return response;

  const p = data.product;
  const unit = Number(p.unitPriceGbp ?? p.priceGbp ?? p.amount);
  const totalProduct = Number(p.amount ?? p.priceGbp ?? p.unitPriceGbp);
  const quantity = Number(p.quantity ?? data.quantity ?? 1);

  return json({
    ...data,
    quantity,
    product: {
      ...p,
      name: data.product.name ?? null,
      unitPriceGbp: Number.isFinite(unit) ? unit : null,
      priceGbp: Number.isFinite(totalProduct) ? totalProduct : null,
      price: Number.isFinite(totalProduct) ? totalProduct : null,
      quantity
    },
    serviceFee: data.serviceFee,
    destinationShipping: data.destinationShipping,
    importTax: data.importTax,
    total: data.total
  }, response.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await worker.fetch(request, env);
    if ((url.pathname === "/api/product" || url.pathname === "/api/estimate") && request.method === "GET") {
      return normalize(response);
    }
    return response;
  }
};
