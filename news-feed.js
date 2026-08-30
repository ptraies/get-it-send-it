const FEEDS = [
  { source: "PwC", query: "site:pwc.com (customs OR VAT OR import OR e-commerce OR indirect tax)", sourceDomains: ["pwc.com"] },
  { source: "GOV.UK", query: "site:gov.uk (customs OR VAT OR import OR duty)", sourceDomains: ["gov.uk"] },
  { source: "KPMG", query: "site:kpmg.com (customs OR VAT OR import OR e-commerce)", sourceDomains: ["kpmg.com"] },
];

const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function stripHtml(value) { return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function decodeEntities(value) { return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }

function parseItems(xml, fallbackSource) {
  const items = [];
  for (const match of String(xml || "").matchAll(/<item[\s\S]*?<\/item>/gi)) {
    const block = match[0];
    const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
    const link = decodeEntities(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);
    const pubDate = decodeEntities(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]);
    const sourceMatch = block.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    const sourceUrl = decodeEntities(sourceMatch?.[1]);
    const source = decodeEntities(sourceMatch?.[2]) || fallbackSource;
    const description = stripHtml(decodeEntities(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1]));
    if (!title || !link) continue;
    const date = pubDate ? new Date(pubDate) : null;
    if (date && !Number.isNaN(date.getTime()) && Date.now() - date.getTime() > MAX_AGE_MS) continue;
    items.push({ title: stripHtml(title), link, sourceUrl, date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null, source: stripHtml(source), description });
  }
  return items;
}

function normaliseSource(item, feed) {
  try {
    const host = new URL(item.sourceUrl || item.link).hostname.replace(/^www\./, "");
    if (host.endsWith("pwc.com")) return "PwC";
    if (host.endsWith("gov.uk")) return "GOV.UK";
    if (host.endsWith("kpmg.com")) return "KPMG";
  } catch {}
  return feed.source;
}

function isAllowedSource(item, feed) {
  try {
    const host = new URL(item.sourceUrl || item.link).hostname.replace(/^www\./, "");
    return feed.sourceDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function score(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  let value = 0;
  if (/customs|duty|tariff/.test(text)) value += 5;
  if (/import|vat|gst/.test(text)) value += 4;
  if (/e-commerce|ecommerce|online seller|low.?value|distance sale/.test(text)) value += 4;
  if (/shipping|parcel|delivery|postal/.test(text)) value += 2;
  if (item.date) value += Math.max(0, 10 - Math.floor((Date.now() - new Date(item.date).getTime()) / 86400000));
  return value;
}

async function fetchFeed(feed) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&hl=en-GB&gl=GB&ceid=GB:en`;
  try {
    const response = await fetch(rssUrl, { headers: { Accept: "application/rss+xml, application/xml, text/xml" }, cf: { cacheTtl: 900, cacheEverything: true } });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseItems(xml, feed.source)
      .map(item => ({ ...item, source: normaliseSource(item, feed) }))
      .filter(item => isAllowedSource(item, feed));
  } catch { return []; }
}

export async function getNews() {
  const results = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const seen = new Set();
  const unique = results.filter(item => {
    const key = `${item.source}|${item.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => score(b) - score(a));
  return unique.slice(0, 6);
}

export function newsResponse(items) {
  return new Response(JSON.stringify({ success: true, updatedAt: new Date().toISOString(), items }), {
    headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "public, max-age=900, s-maxage=900", "access-control-allow-origin": "*" },
  });
}

export function newsErrorResponse() {
  return new Response(JSON.stringify({ success: false, items: [] }), { status: 502, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
