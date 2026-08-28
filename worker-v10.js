import currentWorker from "./worker-v9.js";

const NEWS_ITEMS = [
  { section: "Recent changes", country: "San Marino", flag: "🇸🇲", title: "Monofase import-tax profile added", date: "28 August 2026", source: "Tax profile research", badge: "UPDATED" },
  { section: "Recent changes", country: "Worldwide", flag: "🌍", title: "Global VAT/GST planning profiles added", date: "28 August 2026", source: "PwC / local-source review", badge: "UPDATED" }
];

function newsMarkup() {
  const upcoming = NEWS_ITEMS.filter(item => item.section === "Upcoming changes");
  const recent = NEWS_ITEMS.filter(item => item.section === "Recent changes");
  const item = (entry) => `<article class="gis-news-item"><div class="gis-news-flag">${entry.flag}</div><div class="gis-news-body"><div class="gis-news-top"><strong>${entry.country}</strong><span class="gis-news-badge">${entry.badge}</span></div><div class="gis-news-title">${entry.title}</div><div class="gis-news-meta">${entry.date}</div><div class="gis-news-source">Source: ${entry.source}</div></div><div class="gis-news-arrow">→</div></article>`;
  return `<aside class="gis-tax-news" id="tax-news" aria-label="Tax & Import News">
    <div class="gis-news-eyebrow">Tax &amp; Import News</div>
    <div class="gis-news-status"><span class="gis-status-dot"></span><strong>No new updates today</strong></div>
    <p class="gis-news-intro">We check tax rules regularly so our estimates stay useful and up to date.</p>
    <div class="gis-news-section"><h3>Upcoming changes</h3>${upcoming.length ? upcoming.map(item).join("") : `<div class="gis-news-empty">No upcoming changes currently recorded.</div>`}</div>
    <div class="gis-news-section"><h3>Recent changes</h3>${recent.map(item).join("")}</div>
    <a class="gis-news-history" href="#tax-news-history">View all tax update history <span>→</span></a>
    <div class="gis-news-source-box"><div class="gis-source-title">We monitor trusted tax sources</div><div class="gis-source-copy">Our tax profiles are reviewed against official government and customs information, supported by established tax references such as PwC.</div><div class="gis-source-note">Tax updates are reviewed before they change customer-facing estimates.</div></div>
  </aside>`;
}

function enhanceHomePage(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  return new HTMLRewriter()
    .on("head", { element(element) {
      element.append(`<style>
        .hero-grid{align-items:start !important;grid-template-columns:1.05fr .95fr !important;gap:55px !important}
        .hero-grid .visual{position:relative !important;min-height:0 !important;display:block !important;padding-top:0 !important}
        .hero-grid .visual>.blob,.hero-grid .visual>.note{display:none !important}
        .gis-tax-news{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:25px 24px;position:sticky;top:24px;color:var(--ink)}
        .gis-news-eyebrow{font-family:var(--serif);font-size:31px;line-height:1;color:var(--cobalt);letter-spacing:-1px;margin-bottom:18px}
        .gis-news-status{display:flex;align-items:center;gap:9px;color:var(--cobalt);font-size:14px}
        .gis-status-dot{width:10px;height:10px;border-radius:50%;background:#31A35A;box-shadow:0 0 0 4px rgba(49,163,90,.10)}
        .gis-news-intro{font-size:12px;color:#616A74;margin:7px 0 18px}
        .gis-news-section{border-top:1px solid var(--line);padding-top:17px;margin-top:16px}
        .gis-news-section h3{font-family:var(--serif);font-size:18px;color:var(--cobalt);margin:0 0 11px}
        .gis-news-section:first-of-type h3:before{content:"↗";font-family:var(--sans);color:var(--orange);font-weight:800;margin-right:8px}
        .gis-news-section:last-of-type h3:before{content:"▤";font-family:var(--sans);color:var(--cobalt);font-weight:800;margin-right:8px}
        .gis-news-empty{font-size:12px;color:#7A7F84;padding:7px 0 2px}
        .gis-news-item{display:grid;grid-template-columns:26px minmax(0,1fr) 14px;gap:9px;align-items:start;padding:11px 0;border-bottom:1px dashed var(--line)}
        .gis-news-item:last-child{border-bottom:0}.gis-news-flag{font-size:19px;line-height:1.2}.gis-news-body{min-width:0}
        .gis-news-top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;color:var(--cobalt)}
        .gis-news-title{font-size:12px;color:#414A55;line-height:1.35;margin-top:2px}.gis-news-meta,.gis-news-source{font-size:10px;color:#7A7F84;margin-top:3px}
        .gis-news-badge{font-size:9px;line-height:1;border:1px solid #BFE5C8;background:#F1FBF3;color:#2E8A4F;border-radius:999px;padding:4px 6px;font-weight:850;letter-spacing:.03em;white-space:nowrap}
        .gis-news-arrow{color:var(--orange);font-size:17px;padding-top:3px}.gis-news-history{display:flex;justify-content:center;gap:8px;padding:14px 0 3px;color:var(--cobalt);font-size:12px;font-weight:750}.gis-news-history span{color:var(--orange);font-size:15px;line-height:1}
        .gis-news-source-box{margin-top:16px;background:#F4F1E9;border:1px solid #E1DBCD;border-radius:12px;padding:13px 14px}.gis-source-title{font-size:12px;color:var(--cobalt);font-weight:800;margin-bottom:5px}.gis-source-copy,.gis-source-note{font-size:10px;color:#68717C;line-height:1.5}.gis-source-note{margin-top:6px;color:#59626D}
        @media(max-width:820px){.hero-grid{grid-template-columns:1fr !important;gap:40px !important}.hero-grid .visual{order:2}.gis-tax-news{position:relative;top:auto;margin-top:8px}.gis-news-eyebrow{font-size:28px}}
      </style>`, {html:true});
    }})
    .on(".visual", { element(element) { element.setInnerContent(newsMarkup(), {html:true}); } })
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await currentWorker.fetch(request, env);
    if (url.pathname === "/" || url.pathname === "/index.html") return enhanceHomePage(response);
    return response;
  }
};
