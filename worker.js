import worker from "./worker-clean.js";
import { getTaxProfile } from "./tax-profiles.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=UTF-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function cleanPrice(v) { if (typeof v === "number" && Number.isFinite(v)) return v; if (typeof v !== "string") return null; const s = v.replace(/[^0-9.,-]/g, "").trim().replace(/,(?=\d{3}(?:\D|$))/g, ""); const n = Number.parseFloat(s); return Number.isFinite(n) ? n : null; }
function currency(v) { if (!v) return null; const s = String(v).toUpperCase().trim(); return ({ "£":"GBP", "$":"USD", "€":"EUR" })[s] || s; }
async function zyteProduct(env, url) {
  if (!env?.ZYTE_API_KEY || !url) return null;
  try {
    const auth = `Basic ${btoa(`${env.ZYTE_API_KEY}:`)}`;
    const r = await fetch("https://api.zyte.com/v1/extract", { method:"POST", headers:{ Authorization:auth, "Content-Type":"application/json", Accept:"application/json" }, body:JSON.stringify({ url, product:true, productOptions:{ extractFrom:"browserHtml" }, customAttributes:{ stated_weight:{ type:"string", description:"What is the product or package weight exactly as stated on the page? Return the value with its unit. If no weight is explicitly stated, return an empty string." } }, customAttributesOptions:{ method:"extract" } }) });
    if (!r.ok) return null;
    const d = await r.json(), p = d?.product, price = cleanPrice(p?.price), cur = currency(p?.currency);
    if (price === null || !cur) return null;
    const text=String(d?.customAttributes?.values?.stated_weight||""), m=text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(kg|kgs|kilograms?|g|grams?|lb|lbs|pounds?|oz|ounces?)\b/i);
    let weightKg=null;
    if(m){const x=Number(m[1].replace(",",".")),u=m[2].toLowerCase();if(/^kg|kilogram/.test(u))weightKg=x;else if(/^g$|gram/.test(u))weightKg=x/1000;else if(/lb|pound/.test(u))weightKg=x*.45359237;else if(/oz|ounce/.test(u))weightKg=x*.028349523125;}
    return { name:p?.name||null, price, currency:cur, availability:p?.availability||null, weightKg:weightKg&&weightKg>0&&weightKg<1000?weightKg:null, source:"zyte_browser_product" };
  } catch { return null; }
}
async function fx(amount, cur) {
  const c=currency(cur)||"GBP"; if(c==="GBP") return amount;
  try { const r=await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(c)}/GBP`,{headers:{Accept:"application/json"}}); if(!r.ok)return null; const d=await r.json(), rate=num(d?.rate); return rate&&rate>0?amount*rate:null; } catch { return null; }
}
function rebuild(data,z,destination,quantity) {
  const productGbp=num(z.priceGbp); if(productGbp===null)return data;
  const q=Math.max(1,Math.min(99,Math.floor(num(quantity)||1))), productTotal=Math.round(productGbp*q*100)/100, fee=Math.round(Math.max(15,productTotal*.15)*100)/100;
  let shipping=data.destinationShipping?{...data.destinationShipping}:null;
  const unitWeight=num(z.weightKg), shipmentWeight=unitWeight===null?null:unitWeight*q;
  if(shipping&&shipmentWeight!==null){
    if(shipmentWeight>20){shipping={...shipping,low:null,high:null,status:"specialist_quote",shipmentWeightKg:shipmentWeight,basis:`Estimated shipment weight is approximately ${shipmentWeight.toFixed(2)} kg. We do not guess at heavy or specialist shipping.`};}
    else {let mult=1,band="0.75–2 kg";if(shipmentWeight<=.75){mult=.78;band="up to 0.75 kg"}else if(shipmentWeight<=2){band="0.75–2 kg"}else if(shipmentWeight<=5){mult=1.45;band="2–5 kg"}else if(shipmentWeight<=10){mult=2.1;band="5–10 kg"}else{mult=3;band="10–20 kg"}shipping.low=Math.round(shipping.low*mult*100)/100;shipping.high=Math.round(shipping.high*mult*100)/100;shipping.shipmentWeightKg=shipmentWeight;shipping.weightBand=band;shipping.weightKnown=true;shipping.basis=`Weight-aware planning range for approximately ${shipmentWeight.toFixed(2)} kg (${band}). Actual carrier pricing depends on dimensions, packaging and service level.`;}
  }
  const uk=num(data.ukShipping?.amount), ukAmt=data.ukShipping?.status==="confirmed"&&uk!==null?uk:0, profile=getTaxProfile(destination);
  let tax={status:"unknown",low:null,high:null,label:"Estimated local taxes & import charges",basis:"No verified destination tax profile is currently available."};
  const known=shipping&&num(shipping.low)!==null&&num(shipping.high)!==null;
  if(profile&&known&&profile.mode==="rate"){const lo=(productTotal+ukAmt+shipping.low)*Number(profile.minRate),hi=(productTotal+ukAmt+shipping.high)*Number(profile.maxRate);tax={status:"indicative",low:Math.round(lo*100)/100,high:Math.round(hi*100)/100,rateMin:Number(profile.minRate),rateMax:Number(profile.maxRate),label:`Potential ${profile.taxName||"import tax"}`,basis:`Indicative ${profile.displayRate||"standard"} planning rate. Actual import tax, duty and clearance charges depend on the goods, origin, customs value, exemptions and local procedures.`};}
  const taxLo=num(tax.low)||0,taxHi=num(tax.high)||0;
  const total=known?{status:"estimated",low:Math.round((productTotal+ukAmt+fee+shipping.low+taxLo)*100)/100,high:Math.round((productTotal+ukAmt+fee+shipping.high+taxHi)*100)/100,currency:"GBP",quantity:q}:{status:"partial",low:null,high:null,currency:"GBP",quantity:q};
  return {...data,product:{name:z.name||data.product?.name||null,price:z.price,currency:z.currency,priceGbp:productGbp,unitPriceGbp:productGbp,availability:z.availability||data.product?.availability||null,weightKg:unitWeight,quantity:q},taxProfile:profile?{...profile}:data.taxProfile||null,destinationShipping:shipping,serviceFee:{status:"confirmed",amount:fee,rate:.15,minimum:15,basis:"The greater of £15 or 15% of the product price only. Shipping and destination taxes are excluded."},importTax:tax,total,quantity:q,priceSource:"Zyte live product extraction"};
}

export default { async fetch(request,env) {
  const url=new URL(request.url), response=await worker.fetch(request,env);
  if(url.pathname!=="/api/product"||request.method!=="GET")return response;
  let data;try{data=await response.clone().json()}catch{return response}
  if(!data?.success)return response;
  const extracted=await zyteProduct(env,url.searchParams.get("url")||""); if(!extracted)return response;
  const priceGbp=await fx(extracted.price,extracted.currency); if(priceGbp===null)return response;
  return json(rebuild(data,{...extracted,priceGbp},(url.searchParams.get("destination")||"").toUpperCase().trim(),url.searchParams.get("quantity")||"1"),response.status);
} };
