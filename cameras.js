// Speed and red-light camera locations for NYC.
// The city doesn't publish camera coordinates, so we rebuild them:
//   1. Camera tickets from the current fiscal year list each camera's intersection ("WB N CONDUIT AVE @ 143RD RD").
//   2. The city's street centerline map gives each street's geometry.
//   3. Where the two streets meet is the camera.
const fs = require("fs");

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const TICKETS = ["pvqr-7yc4", "9mwx-gamw"];        // FY2027 (current), FY2026
const CENTERLINE = "inkn-q76z";
const CODES = { "36": "speed", "7": "redlight" };   // 36 = school zone speed camera, 7 = red light camera
const MIN_TICKETS = 25;                             // skip one-off or retired spots
const CACHE = "/tmp/cameras.json";
const BORO = { K: "3", BK: "3", Q: "4", QN: "4", BX: "2", NY: "1", MN: "1", R: "5", ST: "5" };

const state = { status: "idle", cameras: [], builtAt: null, stats: {} };

async function soql(id, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`https://data.cityofnewyork.us/resource/${id}.json?${new URLSearchParams(params)}`, {
      headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${id} ${res.status} ${(await res.text()).slice(0, 160)}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `${id} timed out` : e.message);
  } finally { clearTimeout(timer); }
}

const SUFFIX = [
  [/\bBL\b/g, "BLVD"], [/\bBOULEVARD\b/g, "BLVD"], [/\bAVENUE\b(?!\s+[A-Z]$)/g, "AVE"], [/\bAV\b/g, "AVE"],
  [/\bSTREET\b/g, "ST"], [/\bROAD\b/g, "RD"], [/\bPARKWAY\b/g, "PKWY"], [/\bPKY\b/g, "PKWY"],
  [/\bEXPRESSWAY\b/g, "EXPY"], [/\bEXPWY\b/g, "EXPY"], [/\bEXWY\b/g, "EXPY"], [/\bPLACE\b/g, "PL"],
  [/\bDRIVE\b/g, "DR"], [/\bLANE\b/g, "LN"], [/\bTURNPIKE\b/g, "TPKE"], [/\bHIGHWAY\b/g, "HWY"],
  [/\bNORTH\b/g, "N"], [/\bSOUTH\b/g, "S"], [/\bEAST\b/g, "E"], [/\bWEST\b/g, "W"], [/\bSAINT\b/g, "ST"],
];
function norm(s) {
  let n = String(s || "").toUpperCase().replace(/[.,']/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of SUFFIX) n = n.replace(re, to);
  return n.replace(/\s+/g, " ").trim();
}
// Ticket names and city-map names are spelled differently ("212TH ST" vs "212 ST",
// "THIRD AVE" vs "3 AVE", "B 140TH ST" vs "BEACH 140 ST", "REIDAVE" vs "REID AVE").
// Build every reasonable spelling and try them all.
const WORDNUM = { FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10, ELEVENTH: 11, TWELFTH: 12 };
const TRANSFORMS = [
  (n) => n.replace(/\b(\d+)(ST|ND|RD|TH)\b/g, "$1"),                       // 212TH ST -> 212 ST
  (n) => n.replace(/\b(\d+)\b(?=\s+(ST|AVE|RD|PL|DR|TER|CT|LN|WAY)\b)/g, (m, d) => d + ({ 1: "ST", 2: "ND", 3: "RD" }[d % 100 > 10 && d % 100 < 14 ? 0 : d % 10] || "TH")), // 212 ST -> 212TH ST
  (n) => n.replace(/\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH)\b/g, (w) => WORDNUM[w]),
  (n) => n.replace(/^B (\d)/, "BEACH $1"),
  (n) => n.replace(/^AVENUE ([A-Z])$/, "AVE $1"),
  (n) => n.replace(/^AVE ([A-Z])$/, "AVENUE $1"),
  (n) => n.replace(/^([A-Z])\s+AVE$/, "AVE $1"),                                // S AVE -> AVE S
  (n) => n.replace(/([A-Z]{3,})(AVE|PKWY|BLVD|ST|RD)$/, (m, a, b) => (["EAST", "WEST", "FIRST", "BROAD", "MAIN"].some((w) => a.endsWith(w)) && b === "ST" ? m : `${a} ${b}`)),
  (n) => n.replace(/^LENOX AVE$/, "MALCOLM X BLVD"),
  (n) => n.replace(/^([NSEW]) (ST|AVE|RD|DR|BLVD|LOOP)$/, (m, d, t) => `${{ N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST" }[d]} ${t}`),
  (n) => n.replace(/^ADAM CLAYTON POWELL( JR)? BLVD$/, "7 AVE"),
  (n) => n.replace(/\s+(SVC|SERVICE) RD\b.*$/, ""),
];
function variants(n) {
  const out = new Set([n]);
  for (let round = 0; round < 3; round++)
    for (const v of [...out]) for (const f of TRANSFORMS) { const x = f(v).replace(/\s+/g, " ").trim(); if (x) out.add(x); }
  return [...out].slice(0, 12);
}

// "WB N. CONDUIT AVE @" + "143RD RD"  ->  {dir:"WB", a:"N CONDUIT AVE", b:"143RD RD"}
function parseLocation(street, cross) {
  const s = String(street || ""), c = String(cross || "");
  let joined = (s.length >= 20 ? s + c : `${s} ${c}`).replace(/\s+/g, " ").trim();
  let dir = null;
  const m = joined.match(/^(NB|SB|EB|WB)\s+(.*)$/i);
  if (m) { dir = m[1].toUpperCase(); joined = m[2]; }
  // "(W/B)", "(S/B)", "E/B" written inside the name
  joined = joined.replace(/\(?\b([NSEW])\s*\/\s*B\b\)?/gi, (x, d) => { if (!dir) dir = d.toUpperCase() + "B"; return " "; });
  const [a, b] = joined.split("@").map((x) => norm(x));
  if (!a || !b) return null;
  return { dir, a, b };
}

// Ticket counts per camera location. One light query per camera type, recent months only,
// busiest locations first, so the city's API answers quickly.
async function loadLocations() {
  const seen = new Map();
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10) + "T00:00:00";
  for (const id of TICKETS) {
    for (const [code, type] of Object.entries(CODES)) {
      const t0 = Date.now();
      state.stats.phase = `tickets ${id} code ${code}`;
      let rows = [];
      try {
        rows = await soql(id, {
          $select: "street_name,intersecting_street,violation_county,count(*) as n",
          $where: `violation_code='${code}' AND issue_date >= '${since}'`,
          $group: "street_name,intersecting_street,violation_county",
          $order: "n DESC", $limit: "4000",
        });
      } catch (e) { state.stats[`err_${id}_${code}`] = e.message; }
      state.stats[`rows_${id}_${code}`] = `${rows.length} in ${Math.round((Date.now() - t0) / 1000)}s`;
      for (const r of rows) {
        if (Number(r.n) < MIN_TICKETS) continue;
        const loc = parseLocation(r.street_name, r.intersecting_street);
        const boro = BORO[String(r.violation_county || "").toUpperCase()];
        if (!loc || !boro) continue;
        const key = `${type}|${boro}|${loc.dir}|${loc.a}|${loc.b}`;
        if (!seen.has(key)) seen.set(key, { type, boro, ...loc, n: Number(r.n) });
      }
    }
    if (seen.size > 200) break; // current year is enough once it has data
  }
  return [...seen.values()];
}

// Street geometry, fetched in batches of names per borough
async function loadStreets(locs) {
  const byBoro = {};
  for (const l of locs) for (const s of [l.a, l.b]) for (const v of variants(s)) (byBoro[l.boro] ||= new Set()).add(v);
  const geom = {}; // "boro|NAME" -> list of polylines
  const speed = {}; // "boro|NAME" -> posted speed
  const jobs = [];
  for (const [boro, set] of Object.entries(byBoro)) {
    const names = [...set];
    for (let i = 0; i < names.length; i += 40) {
      const list = names.slice(i, i + 40).map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
      jobs.push({ boro, list });
    }
  }
  let done = 0;
  const total = jobs.length;
  const worker = async () => {
    while (jobs.length) {
      const { boro, list } = jobs.shift();
      state.stats.phase = `streets ${done + 1}/${total}`;
      try {
        const rows = await soql(CENTERLINE, {
          $select: "stname_label,the_geom,posted_speed",
          $where: `boroughcode='${boro}' AND stname_label in(${list})`, $limit: "50000",
        });
        for (const r of rows) {
          const k = `${boro}|${norm(r.stname_label)}`;
          const lines = (geom[k] ||= []);
          for (const line of r.the_geom?.coordinates || []) if (line.length > 1) lines.push(line);
          if (r.posted_speed && Number(r.posted_speed) > 0) speed[k] = Number(r.posted_speed);
        }
      } catch (e) { state.stats.streetErrors = (state.stats.streetErrors || 0) + 1; }
      done++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  state.stats.streetQueries = done;
  return { geom, speed };
}

const meters = (p, q) => {
  const dx = (p[0] - q[0]) * 84300, dy = (p[1] - q[1]) * 111200; // NYC latitude
  return Math.hypot(dx, dy);
};

// Where two streets meet. A and B are lists of polylines ([[lng,lat],...]).
// Works in local meters; checks true crossings plus near-misses (T-junctions, small gaps).
const KX = 84300, KY = 111200;
function segs(lines) {
  const out = [];
  for (const l of lines) for (let i = 0; i < l.length - 1; i++) out.push([l[i][0] * KX, l[i][1] * KY, l[i + 1][0] * KX, l[i + 1][1] * KY]);
  return out;
}
function ptSeg(px, py, s) {
  const [x1, y1, x2, y2] = s, dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return [Math.hypot(px - qx, py - qy), qx, qy];
}
function cross(a, b) {
  const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (!d) return null;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d, u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [x1 + t * (x2 - x1), y1 + t * (y2 - y1)] : null;
}
function meet(A, B) {
  const SA = segs(A), SB = segs(B);
  const C = 150, grid = new Map(); // 150 m cells
  const cellsOf = (s) => {
    const out = [];
    for (let x = Math.floor(Math.min(s[0], s[2]) / C) - 1; x <= Math.floor(Math.max(s[0], s[2]) / C) + 1; x++)
      for (let y = Math.floor(Math.min(s[1], s[3]) / C) - 1; y <= Math.floor(Math.max(s[1], s[3]) / C) + 1; y++) out.push(`${x}|${y}`);
    return out;
  };
  SB.forEach((s, i) => cellsOf(s).forEach((k) => (grid.get(k) || grid.set(k, []).get(k)).push(i)));
  let best = null, bestD = Infinity;
  for (const a of SA) {
    const near = new Set();
    for (const k of cellsOf(a)) for (const i of grid.get(k) || []) near.add(i);
    for (const i of near) {
      const b = SB[i];
      const x = cross(a, b);
      if (x) return [x[0] / KX, x[1] / KY];
      for (const [px, py, s] of [[a[0], a[1], b], [a[2], a[3], b], [b[0], b[1], a], [b[2], b[3], a]]) {
        const [d, qx, qy] = ptSeg(px, py, s);
        if (d < bestD) { bestD = d; best = [(px + qx) / 2 / KX, (py + qy) / 2 / KY]; }
      }
    }
  }
  return bestD <= 60 ? best : null;
}

async function build() {
  // A build stuck for 10+ minutes is abandoned so a new one can start
  if (state.status === "building" && Date.now() - (state.startedMs || 0) < 10 * 60 * 1000) return;
  state.startedMs = Date.now();
  state.status = "building";
  state.stats = { startedAt: new Date().toISOString() };
  try {
    const locs = await loadLocations();
    state.stats.locations = locs.length;
    const { geom, speed } = await loadStreets(locs);
    const pick = (boro, name) => {
      let pts = [], k = null;
      for (const v of variants(name)) if (geom[`${boro}|${v}`]) { pts = pts.concat(geom[`${boro}|${v}`]); k ||= `${boro}|${v}`; }
      return k ? { pts, k } : null;
    };
    const cams = [];
    const unmatched = [];
    for (const l of locs) {
      const A = pick(l.boro, l.a), B = pick(l.boro, l.b);
      const at = A && B ? meet(A.pts, B.pts) : null;
      if (!at) { if (unmatched.length < 80) unmatched.push(`${l.a} @ ${l.b}`); continue; }
      cams.push({ type: l.type, dir: l.dir, lng: +at[0].toFixed(6), lat: +at[1].toFixed(6),
        name: `${l.a} @ ${l.b}`, limit: speed[A.k] || speed[B.k] || null, n: l.n });
    }
    state.cameras = cams;
    state.builtAt = new Date().toISOString();
    state.status = "ready";
    state.stats.placed = cams.length;
    state.stats.phase = "done";
    state.stats.seconds = Math.round((Date.now() - state.startedMs) / 1000);
    state.stats.unmatchedSample = unmatched;
    try { fs.writeFileSync(CACHE, JSON.stringify({ builtAt: state.builtAt, cameras: cams })); } catch {}
  } catch (e) {
    state.status = state.cameras.length ? "ready" : "error";
    state.stats.error = e.message;
  }
}

function start() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (c.cameras?.length) Object.assign(state, { status: "ready", cameras: c.cameras, builtAt: c.builtAt });
  } catch {}
  if (state.status !== "ready") build();
  setInterval(build, 7 * 24 * 3600 * 1000).unref(); // refresh weekly
}

module.exports = { state, start, build, parseLocation, norm, meet, variants };
