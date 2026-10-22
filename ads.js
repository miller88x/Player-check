// Free-tier ads. Shown only on stop screens (search, tickets, parked car, parking check, route preview), never while driving,
// never to paid plans. Today: Rova's own local-business deals from ads.json. In the App Store / Google Play builds,
// AdMob fills the same spot when no local deal matches.
//
// ads.json entry: { "id": "joes-wash", "name": "Joe's Car Wash", "text": "$5 off any wash with Rova",
//   "cta": "Get directions", "url": "https://…" (optional), "phone": "+17185550100" (optional),
//   "lat": 40.7, "lng": -73.9, "radiusMi": 3 (omit lat/lng for citywide), "until": "2027-03-01", "active": true }

const fs = require("fs");
const path = require("path");


const FILE = path.join(__dirname, "ads.json");
const RUN_KEY = process.env.ALERTS_KEY || "";
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

let ads = [];
try { ads = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { ads = []; }
const live = () => { const today = new Date().toISOString().slice(0, 10); return ads.filter((a) => a.active !== false && (!a.until || a.until >= today)); };

// Views and taps per ad (resets when the server restarts; enough to show an advertiser the first numbers)
const stats = {};
const bump = (id, k) => { (stats[id] ||= { views: 0, taps: 0, since: new Date().toISOString() })[k]++; };

const miles = (a, b) => {
  const R = 3958.8, r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
function pick(lat, lng) {
  const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const fits = live().filter((a) => a.lat == null || (here && miles(here, a) <= (a.radiusMi || 3)));
  if (!fits.length) return null;
  const a = fits[Math.floor(Math.random() * fits.length)];
  return { id: a.id, name: a.name, text: a.text, cta: a.cta || (a.phone ? "Call" : "Open"), phone: a.phone || null, hasUrl: !!a.url,
    at: a.lat != null ? { lat: a.lat, lng: a.lng } : null, dist: here && a.lat != null ? Math.round(miles(here, a) * 10) / 10 : null };
}

let mailer = null;
async function emailLead(lead) {
  if (!GMAIL_USER || !GMAIL_PASS) return false;
  mailer ||= require("nodemailer").createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  await mailer.sendMail({ from: `Rova <${GMAIL_USER}>`, to: GMAIL_USER, replyTo: lead.contact.includes("@") ? lead.contact : undefined,
    subject: `New Rova advertiser: ${lead.business}`,
    text: `Business: ${lead.business}\nContact: ${lead.contact}\nArea: ${lead.area || "-"}\nNote: ${lead.note || "-"}\nSent: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}` });
  return true;
}
const clean = (v, n) => String(v || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

function routes(url, res, send, readBody, req) {
  const p = url.pathname;
  if (!p.startsWith("/api/ads")) return false;

  // Store apps: which AdMob banner to use. Test ads until ADMOB_LIVE=1 on Render (flip at launch, never click your own live ads).
  if (p === "/api/ads/config") {
    send(res, 200, { android: "ca-app-pub-2690587342980831/2480545795", ios: process.env.ADMOB_IOS_BANNER || null, testing: process.env.ADMOB_LIVE !== "1" });
    return true;
  }
  if (p === "/api/ads" && req.method === "GET") {
    const ad = pick(parseFloat(url.searchParams.get("lat")), parseFloat(url.searchParams.get("lng")));
    if (ad) bump(ad.id, "views");
    send(res, 200, { ad });
    return true;
  }
  if (p === "/api/ads/tap" && req.method === "GET") {
    const a = live().find((x) => x.id === url.searchParams.get("id"));
    if (!a || !a.url) { send(res, 404, { error: "Not found" }); return true; }
    bump(a.id, "taps");
    res.writeHead(302, { Location: a.url, "Cache-Control": "no-store" }); res.end();
    return true;
  }
  if (p === "/api/ads/count" && req.method === "POST") { // phone/directions taps (no web link to redirect through)
    readBody(req).then((b) => { if (live().some((x) => x.id === b.id)) bump(b.id, "taps"); send(res, 200, { ok: true }); }).catch(() => send(res, 400, {}));
    return true;
  }
  if (p === "/api/ads/lead" && req.method === "POST") {
    readBody(req).then(async (b) => {
      const lead = { business: clean(b.business, 80), contact: clean(b.contact, 80), area: clean(b.area, 80), note: clean(b.note, 300) };
      if (!lead.business || lead.contact.length < 5) return send(res, 400, { error: "Add your business name and a phone or email." });
      console.log("ad lead:", JSON.stringify(lead));
      try { await emailLead(lead); } catch (e) { console.error("ad lead email:", e.message); }
      send(res, 200, { ok: true });
    }).catch(() => send(res, 400, { error: "Bad request" }));
    return true;
  }
  if (p === "/api/ads/stats") {
    if (!RUN_KEY || url.searchParams.get("key") !== RUN_KEY) { send(res, 403, { error: "Forbidden" }); return true; }
    send(res, 200, { ads: live().map((a) => ({ id: a.id, name: a.name, until: a.until || null, ...(stats[a.id] || { views: 0, taps: 0 }) })) });
    return true;
  }
  send(res, 404, { error: "Not found" });
  return true;
}

module.exports = { routes, pick };
