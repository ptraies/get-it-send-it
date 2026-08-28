import currentWorker from "./worker-v7.js";

function enhanceHomePage(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>
          .waiting-message {
            display:none;
            margin-top:16px;
            padding:18px 20px;
            border:1px solid #f4c7aa;
            border-radius:14px;
            background:#fff7f1;
            color:#8f421d;
            font-size:16px;
            font-weight:800;
            line-height:1.4;
            text-align:center;
            box-shadow:0 8px 24px rgba(243,106,33,.08);
          }
          .waiting-message.show { display:block; }
          .waiting-message::after {
            content:"";
            display:inline-block;
            width:10px;
            height:10px;
            margin-left:9px;
            border-radius:50%;
            background:#F36A21;
            vertical-align:1px;
            animation:gisPulse 1s ease-in-out infinite;
          }
          @keyframes gisPulse { 0%,100%{opacity:.35;transform:scale(.8)} 50%{opacity:1;transform:scale(1.15)} }
        </style>`, { html: true });
      }
    })
    .on("#waitingMessage", {
      element(element) {
        element.setInnerContent("We're calculating how much it'll cost to get this to you!");
      }
    })
    .on("#rangeLabel", {
      element(element) {
        element.setInnerContent("Amount payable to Get It, Send It — before local taxes or import charges.");
      }
    })
    .on("body", {
      text(text) {
        const value = text.text;
        if (value === "Potential import charges") {
          text.replace("Estimated local taxes & import charges");
        } else if (value === "Potential overall cost") {
          text.replace("Potential total including local taxes");
        } else if (value === "Import VAT, customs duty and carrier/clearance charges can depend on the product, value, origin, destination and the way the shipment is declared. Any figure shown here is indicative, not a guaranteed customs charge.") {
          text.replace("These are estimated destination-side taxes and import charges. They may be payable separately from your Get It, Send It payment, depending on the destination, product and customs arrangements. Any figure shown is indicative, not a guaranteed customs charge.");
        }
      }
    })
    .transform(response);
}

export default {
  async fetch(request, env) {
    const response = await currentWorker.fetch(request, env);
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return enhanceHomePage(response);
    return response;
  }
};
