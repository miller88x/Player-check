// Ticket app — Step 2: plate ticket lookup + ticket locations for the map
// Zero dependencies. Needs Node 18+ (built-in fetch). Deploys to Render as a Web Service.
const http = require("http");
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

const PORT = process.env.PORT || 3000;
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

function toDate(mmddyyyy) {
  const [m, d, y] = String(mmddyyyy || "").split("/");
  return y ? new Date(Number(y), Number(m) - 1, Number(d)) : null;
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

async function lookup(plate, state, opts = {}) {
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

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/tickets") {
      const plate = (url.searchParams.get("plate") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const state = (url.searchParams.get("state") || "NY").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (plate.length < 2 || plate.length > 8) return send(res, 400, { error: "Enter a plate with 2 to 8 letters or numbers." });
      try {
        return send(res, 200, await lookup(plate, state));
      } catch (e) {
        return send(res, 502, { error: "Couldn't reach NYC ticket records. Try again in a minute." });
      }
    }

    if (url.pathname.startsWith("/api/cameras/area") && uscams.routes(url, res, send)) return;
    if (url.pathname === "/api/cameras") {
      const c = cameras.state;
      return send(res, 200, { status: c.status, builtAt: c.builtAt, count: c.cameras.length, cameras: c.status === "ready" ? c.cameras : [] });
    }
    // App error reports from phones (last 100), to find bugs that only happen on real devices
    if (url.pathname === "/api/log") {
      if (req.method === "POST") return readBody(req).then((b) => { (global.appLog ||= []).unshift({ ...b, ip: undefined }); global.appLog.length = Math.min(global.appLog.length, 100); send(res, 200, { ok: true }); }).catch(() => send(res, 400, {}));
      return send(res, 200, { errors: global.appLog || [] });
    }
    if (url.pathname.startsWith("/api/trip") && trips.routes(url, res, send, readBody, req)) return;
    if (/^\/t\/[a-z0-9]{8}$/.test(url.pathname)) return send(res, 200, trips.page(url.pathname.slice(3)), "text/html; charset=utf-8");
    if (url.pathname.startsWith("/api/tts") && tts.routes(url, res, send, req)) return;
    if ((url.pathname.startsWith("/api/auth/") || url.pathname === "/api/me") && auth.routes(url, res, send, req)) return;
    if (url.pathname.startsWith("/api/reports") && reports.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/park") && park.routes(url, res, send)) return;
    if (url.pathname.startsWith("/api/dispute") && dispute.routes(url, res, send, readBody, req)) return;
    if (url.pathname.startsWith("/api/alerts/") && alerts.routes(url, res, send, readBody, req)) return;
    if (url.pathname === "/api/cameras/rebuild") { cameras.build(); return send(res, 200, { started: true }); }
    if (url.pathname === "/api/cameras/status") {
      const c = cameras.state;
      return send(res, 200, { status: c.status, builtAt: c.builtAt, count: c.cameras.length, stats: c.stats, sample: c.cameras.slice(0, 5) });
    }

    if (url.pathname === "/health") return send(res, 200, { ok: true });

    // Serve the app
    // Home-screen app: icon + manifest so "Add to Home Screen" opens full screen like a real app
    if (["/apple-touch-icon.png", "/icon-512.png", "/rova-logo.jpg"].includes(url.pathname)) {
      return fs.readFile(path.join(__dirname, url.pathname.slice(1)), (err, b) => {
        if (err) return send(res, 404, "Not found", "text/plain");
        res.writeHead(200, { "Content-Type": url.pathname.endsWith(".jpg") ? "image/jpeg" : "image/png", "Cache-Control": "public, max-age=604800" }); res.end(b);
      });
    }
    if (url.pathname === "/manifest.json") {
      return send(res, 200, JSON.stringify({ name: "Rova", short_name: "Rova", start_url: "/", display: "standalone", orientation: "portrait",
        background_color: "#202124", theme_color: "#202124", icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] }), "application/manifest+json");
    }
    const file = path.join(__dirname, "index.html");
    fs.readFile(file, (err, html) => (err ? send(res, 500, "Missing index.html", "text/plain") : send(res, 200, html, "text/html; charset=utf-8")));
  })
  .listen(PORT, () => { console.log(`Ticket app running on port ${PORT}`); cameras.start(); });
alerts.init(lookup);
