const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }

  // Reject obvious private IPv4 addresses.
  const parts = host.split(".").map(Number);

  if (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = parts;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
}

function cleanPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[^0-9.,-]/g, "").trim();

  if (!cleaned) return null;

  // Handle common formats such as 7.99 and 1,299.99.
  const normalized = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, "");

  const number = Number.parseFloat(normalized);

  return Number.isFinite(number) ? number : null;
}

function findProductOffer(value) {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findProductOffer(item);
      if (result) return result;
    }

    return null;
  }

  const type = Array.isArray(value["@type"])
    ? value["@type"].map(String).join(" ")
    : String(value["@type"] || "");

  if (/product/i.test(type)) {
    const offers = value.offers;

    if (offers) {
      const offerList = Array.isArray(offers) ? offers : [offers];

      for (const offer of offerList) {
        if (!offer || typeof offer !== "object") continue;

        const price = cleanPrice(offer.price);

        if (price !== null) {
          return {
            name: value.name || null,
            price,
            currency: offer.priceCurrency || null,
            availability: offer.availability || null
          };
        }
      }
    }
  }

  for (const key of Object.keys(value)) {
    const result = findProductOffer(value[key]);
    if (result) return result;
  }

  return null;
}

function extractProductFromHtml(html) {
  // First look for JSON-LD structured product data.
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const match of scripts) {
    const raw = match[1].trim();

    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      const result = findProductOffer(data);

      if (result) return result;
    } catch {
      // Some sites contain malformed JSON-LD.
      // Ignore it and continue looking.
    }
  }

  return null;
}

function normaliseCurrency(currency) {
  if (!currency) return null;

  const value = String(currency).toUpperCase().trim();

  const aliases = {
    "£": "GBP",
    "$": "USD",
    "€": "EUR"
  };

  return aliases[value] || value;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Our product-price API.
    if (url.pathname === "/api/product") {
      if (request.method !== "GET") {
        return jsonResponse(
          { success: false, error: "Method not allowed." },
          405
        );
      }

      const productUrl = url.searchParams.get("url");

      if (!productUrl) {
        return jsonResponse(
          { success: false, error: "Please provide a product URL." },
          400
        );
      }

      let target;

      try {
        target = new URL(productUrl);
      } catch {
        return jsonResponse(
          { success: false, error: "That doesn't appear to be a valid URL." },
          400
        );
      }

      if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
        return jsonResponse(
          { success: false, error: "Only web URLs are supported." },
          400
        );
      }

      if (isPrivateHostname(target.hostname)) {
        return jsonResponse(
          { success: false, error: "That URL cannot be accessed." },
          400
        );
      }

      try {
        const response = await fetch(target.toString(), {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; GetItSendIt/1.0; +https://getitsendit.co.uk)"
          },
          redirect: "follow"
        });

        if (!response.ok) {
          return jsonResponse(
            {
              success: false,
              error: `The retailer returned HTTP ${response.status}.`
            },
            502
          );
        }

        const contentType = response.headers.get("content-type") || "";

        if (!contentType.includes("text/html")) {
          return jsonResponse(
            {
              success: false,
              error: "That link doesn't appear to be a product webpage."
            },
            422
          );
        }

        const html = await response.text();
        const product = extractProductFromHtml(html);

        if (!product) {
          return jsonResponse({
            success: false,
            error: "We couldn't automatically find the product price.",
            needsManualPrice: true
          });
        }

        return jsonResponse({
          success: true,
          product: {
            name: product.name,
            price: product.price,
            currency: normaliseCurrency(product.currency),
            availability: product.availability
          }
        });
      } catch (error) {
        return jsonResponse(
          {
            success: false,
            error: "We couldn't access that product page.",
            needsManualPrice: true
          },
          502
        );
      }
    }

    // Everything else is handled by the existing website.
    return env.ASSETS.fetch(request);
  }
};
