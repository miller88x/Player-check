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
  const res = await fetch(`https://data.cityofnewyork.us/resource/${id}.json?${new URLSearchParams(params)}`, {
    headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${id} ${res.status}`);
  return res.json();
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
// Lettered avenues are "AVENUE T" on the city map but "AVE T" on tickets
function variants(n) {
  const out = new Set([n]);
  const m = n.match(/^AVE ([A-Z])$/);
  if (m) out.add(`AVENUE ${m[1]}`);
  if (/^\d+(ST|ND|RD|TH)$/.test(n)) out.add(`${n} ST`);
  return [...out];
}

// "WB N. CONDUIT AVE @" + "143RD RD"  ->  {dir:"WB", a:"N CONDUIT AVE", b:"143RD RD"}
function parseLocation(street, cross) {
  const s = String(street || ""), c = String(cross || "");
  const joined = (s.length >= 20 ? s + c : `${s} ${c}`).replace(/\s+/g, " ").trim();
  const m = joined.match(/^(NB|SB|EB|WB)\s+(.*)$/i);
  const dir = m ? m[1].toUpperCase() : null;
  const rest = m ? m[2] : joined;
  const [a, b] = rest.split("@").map((x) => norm(x));
  if (!a || !b) return null;
  return { dir, a, b };
}

// Ticket counts per camera location
async function loadLocations() {
  const where = `violation_code in(${Object.keys(CODES).map((c) => `'${c}'`).join(",")})`;
  const seen = new Map();
  for (const id of TICKETS) {
    let rows = [];
    try {
      rows = await soql(id, {
        $select: "street_name,intersecting_street,violation_county,violation_code,count(*) as n",
        $where: where, $group: "street_name,intersecting_street,violation_county,violation_code",
        $having: `count(*) >= ${MIN_TICKETS}`, $limit: "50000",
      });
    } catch (e) { state.stats[`err_${id}`] = e.message; continue; }
    for (const r of rows) {
      const loc = parseLocation(r.street_name, r.intersecting_street);
      const boro = BORO[String(r.violation_county || "").toUpperCase()];
      if (!loc || !boro) continue;
      const key = `${CODES[r.violation_code]}|${boro}|${loc.dir}|${loc.a}|${loc.b}`;
      if (!seen.has(key)) seen.set(key, { type: CODES[r.violation_code], boro, ...loc, n: Number(r.n) });
    }
    if (seen.size) break; // current year is enough once it has data
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
  const worker = async () => {
    while (jobs.length) {
      const { boro, list } = jobs.shift();
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
  if (state.status === "building") return;
  state.status = "building";
  state.stats = { startedAt: new Date().toISOString() };
  try {
    const locs = await loadLocations();
    state.stats.locations = locs.length;
    const { geom, speed } = await loadStreets(locs);
    const pick = (boro, name) => {
      for (const v of variants(name)) if (geom[`${boro}|${v}`]) return { pts: geom[`${boro}|${v}`], k: `${boro}|${v}` };
      return null;
    };
    const cams = [];
    const unmatched = [];
    for (const l of locs) {
      const A = pick(l.boro, l.a), B = pick(l.boro, l.b);
      const at = A && B ? meet(A.pts, B.pts) : null;
      if (!at) { if (unmatched.length < 40) unmatched.push(`${l.a} @ ${l.b}`); continue; }
      cams.push({ type: l.type, dir: l.dir, lng: +at[0].toFixed(6), lat: +at[1].toFixed(6),
        name: `${l.a} @ ${l.b}`, limit: speed[A.k] || null, n: l.n });
    }
    state.cameras = cams;
    state.builtAt = new Date().toISOString();
    state.status = "ready";
    state.stats.placed = cams.length;
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

module.exports = { state, start, build, parseLocation, norm, meet };
