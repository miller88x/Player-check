// Ticket app — Step 2: plate ticket lookup + ticket locations for the map
// Zero dependencies. Needs Node 18+ (built-in fetch). Deploys to Render as a Web Service.
const http = require("http");
const STARTED = new Date().toISOString();
const fs = require("fs");
const path = require("path");
const cameras = require("./cameras");
const alerts = require("./alerts");
const dispute = require("./dispute");
const park = require("./park");
const reports = require("./reports");
const uscams = require("./uscams");
const auth = require("./auth");
const tts = require("./tts");
const trips = require("./trips");
const rovers = require("./rovers");
const truck = require("./truck");
const billing = require("./billing");
const ads = require("./ads");
const legal = require("./legal");
const push = require("./push");
const parkwatch = require("./parkwatch");
const signphoto = require("./signphoto");
const traffic = require("./traffic");
const ask = require("./ask");
const team = require("./team");

const zlib = require("zlib");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const selftest = require("./selftest");
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || ""; // optional: higher NYC Open Data rate limits
const DATASET = "https://data.cityofnewyork.us/resource/nc67-uf89.json"; // Open Parking and Camera Violations

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// ---------- Step 2: ticket locations ----------
// Yearly "Parking Violations Issued" datasets carry the street address for each summons.
const FY_DATASETS = {
  2022: "7mxj-7a6y", 2023: "869v-vr48", 2024: "8zf9-spf8",
  2025: "m5vz-tzqv", 2026: "9mwx-gamw", 2027: "pvqr-7yc4",
};
const BORO = { K: "Brooklyn", BK: "Brooklyn", Q: "Queens", QN: "Queens", QNS: "Queens", BX: "Bronx", BRONX: "Bronx",
  NY: "Manhattan", MN: "Manhattan", R: "Staten Island", ST: "Staten Island", RICH: "Staten Island" };
const MAX_MAPPED = 150;              // most recent tickets to place on the map
const geoCache = new Map();          // address -> {lat,lng} | null

const timeout = (ms) => AbortSignal.timeout(ms);

async function socrata(id, where, select) {
  const params = new URLSearchParams({ $select: select, $where: where, $limit: "1000" });
  const res = await fetch(`https://data.cityofnewyork.us/resource/${id}.json?${params}`, {
    headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: timeout(12000),
  });
  if (!res.ok) throw new Error(`socrata ${res.status}`);
  return res.json();
}

async function geocode(text) {
  if (geoCache.has(text)) return geoCache.get(text);
  let hit = null;
  try {
    const res = await fetch(`https://geosearch.planninglabs.nyc/v2/search?size=1&text=${encodeURIComponent(text)}`, { signal: timeout(6000) });
    const f = (await res.json()).features?.[0];
    if (f) hit = { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  } catch {}
  geoCache.set(text, hit);
  if (geoCache.size > 50000) geoCache.delete(geoCache.keys().next().value);
  return hit;
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function addressFor(row, fallbackCounty) {
  const boro = BORO[String(row.violation_county || fallbackCounty || "").toUpperCase()] || "";
  let street = String(row.street_name || "").replace(/^(NB|SB|EB|WB)\s+/i, "").split("@")[0].trim();
  if (!street) return null;
  if (row.house_number) return { text: `${row.house_number} ${street}, ${boro}`.trim(), approx: false, label: `${row.house_number} ${street}` };
  const cross = String(row.intersecting_street || "").replace(/^.*@\s*/, "").trim();
  return { text: `${street}, ${boro}`.trim(), approx: true, label: cross ? `${street} near ${cross}` : street };
}

async function addLocations(tickets) {
  const recent = tickets.filter((t) => t.issued).slice(0, MAX_MAPPED);
  // A summons can land in the issue-date fiscal year or the next one, so check both.
  const byDataset = {};
  for (const t of recent) {
    const [y, m] = t.issued.split("-").map(Number);
    const fy = m >= 7 ? y + 1 : y;
    for (const f of [fy, fy + 1]) if (FY_DATASETS[f]) (byDataset[FY_DATASETS[f]] ||= []).push(t.summons);
  }
  const rows = {};
  const jobs = [];
  for (const [id, list] of Object.entries(byDataset)) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100).map((s) => `'${String(s).replace(/\D/g, "")}'`).join(",");
      jobs.push(socrata(id, `summons_number in(${chunk})`, "summons_number,house_number,street_name,intersecting_street,violation_county")
        .then((r) => r.forEach((x) => (rows[x.summons_number] ||= x))).catch(() => {}));
    }
  }
  await Promise.all(jobs);

  const withAddr = recent.map((t) => ({ t, a: rows[t.summons] ? addressFor(rows[t.summons], t.county) : null })).filter((x) => x.a);
  await pool(withAddr, 6, async ({ t, a }) => {
    const p = await geocode(a.text);
    if (p) t.location = { ...p, address: a.label, approx: a.approx };
  });
  return withAddr.length;
}

// The city's data mixes "12/30/2023" and "2023-12-30T00:00:00.000"; impossible years (typos like 2096) count as unknown
function toDate(v) {
  const s = String(v || "").trim();
  let y, m, d, x;
  if ((x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) [, m, d, y] = x;
  else if ((x = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) [, y, m, d] = x;
  else return null;
  const dt = new Date(Date.UTC(+y, +m - 1, +d, 12));
  if (isNaN(dt) || +y < 1990 || dt > new Date(Date.now() + 864e5)) return null;
  return dt;
}

function classify(t) {
  const due = num(t.amount_due);
  const fine = num(t.fine_amount);
  if (fine === null && due === null) return "expired"; // written off, blank financials
  if (due > 0 && (num(t.penalty_amount) > 0 || num(t.interest_amount) > 0)) return "penalty";
  if (due > 0) return "open";
  if (String(t.violation_status || "").includes("NOT GUILTY")) return "dismissed";
  return "closed";
}

// Demo plate for App Store / Google Play reviewers and screenshots: sample tickets, no real person's plate.
// Dates move with today, so it always shows a fresh ticket, a late fee coming, and one in penalty.
const DEMO_PLATE = "ROVADEMO";
function demoLookup(state) {
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const t = (summons, ago, violation, fine, extra = {}) => ({ summons, issued: day(ago), time: "09:14A", violation, agency: "TRAFFIC", county: "K", precinct: "078",
    fine, penalty: 0, interest: 0, reduction: 0, paid: 0, due: fine, hearing: null, image: null, ageDays: ago, status: "open", judgment: false, ...extra });
  const tickets = [
    t("9990000001", 3, "NO PARKING-STREET CLEANING", 65, { location: { lat: 40.6782, lng: -73.9772, address: "5TH AVE near PARK PL", approx: true } }),
    t("9990000002", 26, "FAIL TO DSPLY MUNI METER RECPT", 65, { location: { lat: 40.6869, lng: -73.9746, address: "FULTON ST near S PORTLAND AVE", approx: true } }),
    t("9990000003", 70, "PHTO SCHOOL ZN SPEED VIOLATION", 50, { penalty: 25, interest: 1.12, due: 76.12, status: "penalty", agency: "DEPARTMENT OF TRANSPORTATION", location: { lat: 40.6713, lng: -73.9636, address: "EASTERN PKWY near WASHINGTON AVE", approx: true } }),
    t("9990000004", 140, "NO STANDING-BUS STOP", 115, { paid: 115, due: 0, status: "closed", hearing: "HEARING HELD-GUILTY" }),
  ];
  const open = tickets.filter((x) => x.status === "open" || x.status === "penalty");
  return { plate: DEMO_PLATE, state, checkedAt: new Date().toISOString(), demo: true,
    summary: { count: tickets.length, openCount: open.length, totalDue: Math.round(open.reduce((s, x) => s + x.due, 0) * 100) / 100, penaltiesAdded: 26.12, judgmentDue: 0, bootRisk: false, mapped: 3 },
    tickets };
}

async function lookup(plate, state, opts = {}) {
  if (plate === DEMO_PLATE) return demoLookup(state);
  const params = new URLSearchParams({ plate, state, $limit: "5000" });
  const res = await fetch(`${DATASET}?${params}`, {
    headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {},
  });
  if (!res.ok) throw new Error(`NYC Open Data returned ${res.status}`);
  const rows = await res.json();
  const now = Date.now();

  const tickets = rows
    .map((t) => {
      const issued = toDate(t.issue_date);
      const status = classify(t);
      const ageDays = issued ? Math.floor((now - issued) / 86400000) : null;
      return {
        summons: t.summons_number,
        issued: issued ? issued.toISOString().slice(0, 10) : null,
        time: t.violation_time || null,
        violation: t.violation || "Unknown violation",
        agency: t.issuing_agency || null,
        county: t.county || null,
        precinct: t.precinct || null,
        fine: num(t.fine_amount),
        penalty: num(t.penalty_amount),
        interest: num(t.interest_amount),
        reduction: num(t.reduction_amount),
        paid: num(t.payment_amount),
        due: num(t.amount_due),
        hearing: t.violation_status || null,
        image: t.summons_image?.url?.replace("http://", "https://") || null,
        ageDays,
        status,
        // NYC unpaid tickets typically go into judgment ~100 days after issue
        judgment: (status === "open" || status === "penalty") && ageDays !== null && ageDays >= (/PHTO|CAMERA|BUS LANE|RED LIGHT/i.test(t.violation || "") ? 75 : 100), // camera tickets: ~75 days, parking: ~100
      };
    })
    .sort((a, b) => String(b.issued).localeCompare(String(a.issued)));

  const open = tickets.filter((t) => t.status === "open" || t.status === "penalty");
  const totalDue = open.reduce((s, t) => s + (t.due || 0), 0);
  const judgmentDue = open.filter((t) => t.judgment).reduce((s, t) => s + (t.due || 0), 0);

  let mapped = 0;
  if (opts.locations !== false) { try { await addLocations(tickets); mapped = tickets.filter((t) => t.location).length; } catch {} }

  return {
    plate,
    state,
    checkedAt: new Date().toISOString(),
    summary: {
      count: tickets.length,
      openCount: open.length,
      totalDue: Math.round(totalDue * 100) / 100,
      penaltiesAdded: Math.round(open.reduce((s, t) => s + (t.penalty || 0) + (t.interest || 0), 0) * 100) / 100,
      judgmentDue: Math.round(judgmentDue * 100) / 100,
      // NYC can boot or tow at more than $350 in parking-ticket judgments
      bootRisk: judgmentDue > 350,
      mapped,
    },
    tickets,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// Compress anything over 1 KB (brotli, else gzip): phones on LTE get pages and data far faster
function compress(buf, req) {
  const ae = String(req?.headers["accept-encoding"] || "");
  if (buf.length < 1024) return { buf, enc: null };
  if (/\bbr\b/.test(ae)) return { buf: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }), enc: "br" };
  if (/\bgzip\b/.test(ae)) return { buf: zlib.gzipSync(buf, { level: 6 }), enc: "gzip" };
  return { buf, enc: null };
}
function send(res, code, body, type = "application/json", cache = "no-store") {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(type === "application/json" ? JSON.stringify(body) : String(body));
  const { buf, enc } = compress(raw, res.req);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": cache, Vary: "Accept-Encoding", "Content-Length": buf.length, ...(enc ? { "Content-Encoding": enc } : {}) });
  res.end(buf);
}
// The app page: read once at startup, pre-compressed, with an ETag so repeat opens download nothing
const PAGE = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "index.html"));
    return { raw, br: zlib.brotliCompressSync(raw), gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16)}"` };
  } catch { return null; }
})();
function sendPage(req, res) {
  if (!PAGE) return send(res, 500, "Missing index.html", "text/plain");
  const h = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: PAGE.etag, Vary: "Accept-Encoding" };
  if (req.headers["if-none-match"] === PAGE.etag) { res.writeHead(304, h); return res.end(); }
  const ae = String(req.headers["accept-encoding"] || ""), enc = /\bbr\b/.test(ae) ? "br" : /\bgzip\b/.test(ae) ? "gzip" : null;
  const buf = enc === "br" ? PAGE.br : enc === "gzip" ? PAGE.gz : PAGE.raw;
  res.writeHead(200, { ...h, "Content-Length": buf.length, ...(enc ? { "Content-Encoding": enc } : {}) });
  res.end(buf);
}
// Small time-limited cache with a size cap (oldest dropped first)
function ttlCache(max, ms) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return; if (Date.now() - e.at > ms) { m.delete(k); return; } return e.v; },
    set(k, v) { m.delete(k); m.set(k, { v, at: Date.now() }); if (m.size > max) m.delete(m.keys().next().value); },
  };
}
const ticketCache = ttlCache(3000, 3 * 60 * 1000); // same plate checked again within 3 min: instant

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/tickets") {
      const plate = (url.searchParams.get("plate") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const state = (url.searchParams.get("state") || "NY").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (plate.length < 2 || plate.length > 8) return send(res, 400, { error: "Enter a plate with 2 to 8 letters or numbers." });
      try {
        const key = `${plate}|${state}`;
        let out = ticketCache.get(key);
        if (!out) { out = await lookup(plate, state); ticketCache.set(key, out); }
        return send(res, 200, out);
      } catch (e) {
        return send(res, 502, { error: "Couldn't reach NYC ticket records. Try again in a minute." });
      }
    }

    if (url.pathname.startsWith("/api/cameras/area") && uscams.routes(url, res, send)) return;
    if (url.pathname === "/api/cameras") {
      const c = cameras.state;
      return send(res, 200, { status: c.status, builtAt: c.builtAt, count: c.cameras.length, cameras: c.status === "ready" ? c.cameras : [] }, "application/json", c.status === "ready" ? "public, max-age=3600" : "no-store");
    }
    // App error reports from phones (last 100), to find bugs that only happen on real devices
    if (url.pathname === "/api/log") {
      if (req.method === "POST") return readBody(req).then((b) => { (global.appLog ||= []).unshift({ ...b, ip: undefined }); global.appLog.length = Math.min(global.appLog.length, 100); send(res, 200, { ok: true }); }).catch(() => send(res, 400, {}));
      return send(res, 200, { errors: global.appLog || [] });
    }
    if (url.pathname.startsWith("/api/ads") && ads.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/billing/") && billing.routes(url, res, send, req)) return;
    if (url.pathname.startsWith("/api/rovers") && rovers.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/truck/") && truck.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/traffic/") && traffic.routes(url, res, send)) return;
    if (url.pathname === "/api/ask" && ask.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/team/") && team.routes(url, res, send, req)) return;
    if (url.pathname.startsWith("/api/trip") && trips.routes(url, res, send, readBody, req)) return;
    if (/^\/t\/[a-z0-9]{8}$/.test(url.pathname)) return send(res, 200, trips.page(url.pathname.slice(3)), "text/html; charset=utf-8");
    if (url.pathname.startsWith("/api/tts") && tts.routes(url, res, send, req)) return;
    if ((url.pathname.startsWith("/api/auth/") || url.pathname === "/api/me") && auth.routes(url, res, send, req)) return;
    if (url.pathname.startsWith("/api/reports") && reports.routes(url, res, send, readBody, req)) return;
    if (url.pathname === "/api/park/photo" && signphoto.routes(url, res, send, req)) return;
    if (url.pathname.startsWith("/api/park") && park.routes(url, res, send)) return;
    if (url.pathname.startsWith("/api/dispute") && dispute.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/push/") && push.routes(url, res, send, req)) return;
    // The daily alerts trigger also sends phone notifications
    if (url.pathname === "/api/alerts/run" && process.env.ALERTS_KEY && url.searchParams.get("key") === process.env.ALERTS_KEY) push.runAll(lookup).catch(() => {});
    if (url.pathname.startsWith("/api/alerts/") && alerts.routes(url, res, send, readBody, req)) return;
    if (url.pathname === "/api/cameras/rebuild") { cameras.build(); return send(res, 200, { started: true }); }
    if (url.pathname === "/api/cameras/status") {
      const c = cameras.state;
      return send(res, 200, { status: c.status, builtAt: c.builtAt, count: c.cameras.length, stats: c.stats, sample: c.cameras.slice(0, 5) });
    }

    if (legal.routes(url, res, send)) return;
    // Garage booking: SpotHero. Set SPOTHERO_LINK on Render to the FlexOffers partner link (with {lat} {lng}) once approved
    if (url.pathname === "/api/garage") {
      const lat = (+url.searchParams.get("lat")).toFixed(5), lng = (+url.searchParams.get("lng")).toFixed(5);
      const tpl = process.env.SPOTHERO_LINK || "https://spothero.com/search?latitude={lat}&longitude={lng}";
      console.log("garage click", lat, lng);
      res.writeHead(302, { Location: tpl.replace("{lat}", lat).replace("{lng}", lng), "Cache-Control": "no-store" }); return res.end();
    }
    // AdMob checks this file on the developer website listed in the app stores
    if (url.pathname === "/app-ads.txt") return send(res, 200, "google.com, pub-2690587342980831, DIRECT, f08c47fec0942fa0\n", "text/plain", "public, max-age=86400");
    if (url.pathname === "/health") return send(res, 200, { ok: true });

    // Serve the app
    // Home-screen app: icon + manifest so "Add to Home Screen" opens full screen like a real app
    if (url.pathname === "/keepawake.mp4" || url.pathname === "/keepawake.webm") { // tiny silent clip that keeps the phone screen on while driving
      return fs.readFile(path.join(__dirname, url.pathname.slice(1)), (err, b) => { if (err) return send(res, 404, "Not found", "text/plain"); res.writeHead(200, { "Content-Type": url.pathname.endsWith(".webm") ? "video/webm" : "video/mp4", "Content-Length": b.length, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=604800" }); res.end(b); });
    }
    if (["/apple-touch-icon.png", "/icon-512.png", "/rova-logo.jpg"].includes(url.pathname)) {
      return fs.readFile(path.join(__dirname, url.pathname.slice(1)), (err, b) => {
        if (err) return send(res, 404, "Not found", "text/plain");
        res.writeHead(200, { "Content-Type": url.pathname.endsWith(".jpg") ? "image/jpeg" : "image/png", "Cache-Control": "public, max-age=604800" }); res.end(b);
      });
    }
    if ((url.pathname === "/api/health" || url.pathname === "/api/selftest") && selftest.routes(url, res, send)) return;
    if (url.pathname === "/api/version") {
      return send(res, 200, { commit: (process.env.RENDER_GIT_COMMIT || "local").slice(0, 7), started: STARTED });
    }
    if (url.pathname === "/sw.js") {
      return fs.readFile(path.join(__dirname, "sw.js"), (err, b) => (err ? send(res, 404, "Not found", "text/plain") : send(res, 200, b, "application/javascript; charset=utf-8", "no-cache")));
    }
    if (url.pathname === "/manifest.json") {
      return send(res, 200, JSON.stringify({ name: "Rova", short_name: "Rova", start_url: "/", display: "standalone", orientation: "portrait",
        background_color: "#01050e", theme_color: "#01050e", icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] }), "application/manifest+json");
    }
    sendPage(req, res);
  })
  .listen(PORT, () => { console.log(`Ticket app running on port ${PORT}`); cameras.start(); truck.start(); parkwatch.start(); selftest.start(); if (process.env.PARK_AUDIT === "1") setTimeout(() => require("./parkaudit").run(), 20000); if (process.env.PARK_DIAG === "1") setTimeout(() => require("./diag").run(), 5000); });
alerts.init(lookup);
