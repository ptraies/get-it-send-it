import currentWorker from "./worker-v11.js";

const SERVICE_FEE_MIN_GBP = 15;
const SERVICE_FEE_RATE = 0.15;

function jsonResponse(data, status = 200, headers = {}) {
  const clean = { ...headers };
  delete clean["content-length"];
  clean["content-type"] = "application/json; charset=UTF-8";
  clean["cache-control"] = "no-store";
  return new Response(JSON.stringify(data), { status, headers: clean });
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function applyServiceFee(data) {
  if (!data?.success || !data?.product) return data;
  const productPrice = number(data.product?.priceGbp ?? data.product?.price);
  if (productPrice === null || productPrice < 0) return data;

  // Service fee is based on product value only, never UK/international shipping
  // or destination taxes. The customer pays whichever is greater: £15 or 15%.
  const fee = Math.max(SERVICE_FEE_MIN_GBP, productPrice * SERVICE_FEE_RATE);
  const roundedFee = Math.round(fee * 100) / 100;
  const result = { ...data, serviceFee: {
    status: "confirmed",
    amount: roundedFee,
    rate: SERVICE_FEE_RATE,
    minimum: SERVICE_FEE_MIN_GBP,
    basis: `Service fee is the greater of £${SERVICE_FEE_MIN_GBP.toFixed(2)} or ${(SERVICE_FEE_RATE * 100).toFixed(0)}% of the product price.`
  }};

  if (result.total && number(result.total.low) !== null && number(result.total.high) !== null) {
    const oldFee = number(data.serviceFee?.amount);
    const delta = roundedFee - (oldFee ?? SERVICE_FEE_MIN_GBP);
    result.total = {
      ...result.total,
      low: Math.round((number(result.total.low) + delta) * 100) / 100,
      high: Math.round((number(result.total.high) + delta) * 100) / 100,
      currency: "GBP"
    };
  }

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if ((url.pathname === "/api/product" || url.pathname === "/api/estimate") && request.method === "GET") {
      const response = await currentWorker.fetch(request, env);
      let data = null;
      try { data = await response.clone().json(); } catch {}
      if (data?.success) return jsonResponse(applyServiceFee(data), response.status, Object.fromEntries(response.headers));
      return response;
    }

    return currentWorker.fetch(request, env);
  }
};
