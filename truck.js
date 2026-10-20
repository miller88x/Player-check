// Truck mode: routes that stay on NYC's official Truck Route Network, checked segment by segment.
// Data: NYC DOT "New York City Truck Routes" (jjja-shxy) + DCP "Borough Boundaries" (gthc-hcne), both NYC Open Data.
// How it works:
//   1. Find a path ON the truck network (graph of official segments), following the city rules:
//      Through routes when crossing a borough with no stop in it; Local routes for trips that start/end in a borough.
//   2. Turn that path into real turn-by-turn directions (one-way streets respected) by asking the route engine
//      to pass through points along it, pointed in the direction of travel.
//   3. Check every 20 m of the final route against the official network and report anything off it.
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
// Free route engines, tried in order if one doesn't answer (the public demo server is often busy)
const OSRM_HOSTS = [process.env.OSRM_URL, "https://router.project-osrm.org/route/v1/driving", "https://routing.openstreetmap.de/routed-car/route/v1/driving"].filter(Boolean);
// TomTom: real truck routing nationwide (height, weight, length, axles, US hazmat classes) + live traffic
const TOMTOM_KEY = (process.env.TOMTOM_KEY || "").replace(/\s+/g, "");
const H = APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {};
const KX = 84300, KY = 111200; // meters per degree near NYC
const R = (d) => (d * Math.PI) / 180;
const distM = (a, b) => Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY);
const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * KX, (b[1] - a[1]) * KY) * 180 / Math.PI + 360) % 360;

const state = { status: "idle", error: null, asOf: null, builtAt: null, segs: [], nodes: [], adj: [], grid: new Map(), ngrid: new Map(), boros: [], stats: null };
const CELL = 0.002; // ~200 m
const ck = (x, y) => `${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`;

// ---------- loading ----------
async function getJSON(url, ms = 90000) {
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return r.json();
}
function lines(g) { return !g ? [] : g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : []; }
function polys(g) { return !g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []; }

// Truck route data, newest first:
//  1. DCP Street Centerline (inkn-q76z): road-bed level, has truck_route_type (3 Through, 2 Local, 1 Limited Local)
//     and trafdir (FT/TF one-way along/against the drawn line, TW two-way, NV no vehicles). Updated after the fall 2026 redesign.
//  2. DOT Truck Routes (jjja-shxy): backup if the centerline can't be loaded (no one-way directions).
async function pageAll(base, max = 500000) {
  const all = [];
  for (let off = 0; off < max; off += 40000) {
    const j = await getJSON(`${base}&$order=:id&$limit=40000&$offset=${off}`);
    all.push(...(j.features || [])); if ((j.features || []).length < 40000) break;
  }
  return all;
}
const BORO_CODE = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" };
const TRUCK_TYPE = { 3: "Through", 2: "Local", 1: "Limited Local" };
async function build() {
  if (state.status === "loading") return;
  state.status = "loading"; state.error = null;
  try {
    const boro = await getJSON("https://data.cityofnewyork.us/resource/gthc-hcne.geojson?$limit=10");
    let source = "centerline", meta = null, feats = [];
    try {
      [meta, feats] = await Promise.all([
        getJSON("https://data.cityofnewyork.us/api/views/inkn-q76z.json", 30000).catch(() => null),
        pageAll("https://data.cityofnewyork.us/resource/inkn-q76z.geojson?$select=the_geom,full_street_name,truck_route_type,trafdir,boroughcode,from_level_code,to_level_code&$where=truck_route_type IS NOT NULL"),
      ]);
      if (feats.length < 5000) throw new Error(`centerline gave ${feats.length} truck segments`);
    } catch (e) {
      logErr("truck data: centerline failed, using DOT truck routes: " + e.message);
      source = "dot";
      [meta, feats] = await Promise.all([
        getJSON("https://data.cityofnewyork.us/api/views/jjja-shxy.json", 30000).catch(() => null),
        pageAll("https://data.cityofnewyork.us/resource/jjja-shxy.geojson?$select=the_geom,street,routetype,boroname,ltdlocal,restrictio"),
      ]);
    }
    const segs = [], nodes = [], nodeKey = new Map(), adj = [], grid = new Map(), ngrid = new Map();
    const node = (p, lvl) => {
      const k = `${Math.round(p[0] / 2e-5)}|${Math.round(p[1] / 2e-5)}|${lvl || ""}`; // level keeps overpasses from joining streets below
      let i = nodeKey.get(k);
      if (i == null) { i = nodes.length; nodes.push(p); nodeKey.set(k, i); adj.push([]); const c = ck(p[0], p[1]); (ngrid.get(c) || ngrid.set(c, []).get(c)).push(i); }
      return i;
    };
    let oneWay = 0;
    for (const f of feats) {
      const pr = f.properties || {};
      let type, street, boroName, dir = "TW", la = "", lb = "", ltd = "", restr = "";
      if (source === "centerline") {
        type = TRUCK_TYPE[+pr.truck_route_type]; if (!type) continue;
        street = String(pr.full_street_name || "").trim(); boroName = BORO_CODE[+pr.boroughcode] || "";
        dir = String(pr.trafdir || "TW").toUpperCase(); if (dir === "NV") continue;
        la = pr.from_level_code || ""; lb = pr.to_level_code || "";
      } else {
        type = /through/i.test(pr.routetype || "") ? "Through" : /limited/i.test(pr.routetype || "") ? "Limited Local" : "Local";
        street = String(pr.street || "").trim(); boroName = pr.boroname || ""; ltd = pr.ltdlocal || ""; restr = pr.restrictio || "";
      }
      const parts = lines(f.geometry);
      for (const c of parts) {
        if (!c || c.length < 2) continue;
        let len = 0; for (let i = 1; i < c.length; i++) len += distM(c[i - 1], c[i]);
        const id = segs.length;
        const fast = /EXPRESSWAY|EXPWY|EXPY|HIGHWAY|HWY|INTERSTATE|TURNPIKE|BRIDGE|\bBR\b|TUNNEL|THRUWAY|\bPKWY\b|EXIT|\bET\b|RAMP|\bEN\b/i.test(street);
        const sg = { id, c, len, street, type, boro: boroName, ltd, restr, fast, dir };
        sg.a = node(c[0], parts.length === 1 ? la : ""); sg.b = node(c[c.length - 1], parts.length === 1 ? lb : "");
        // one-way streets only get the edge in their legal direction
        if (dir !== "TF") adj[sg.a].push({ id, v: sg.b });
        if (dir !== "FT") adj[sg.b].push({ id, v: sg.a });
        if (dir === "FT" || dir === "TF") oneWay++;
        segs.push(sg);
        for (let i = 0; i < c.length; i++) {
          const add = (p) => { const k = ck(p[0], p[1]); const arr = grid.get(k) || grid.set(k, []).get(k); if (arr[arr.length - 1] !== id) arr.push(id); };
          add(c[i]);
          if (i) { const d = distM(c[i - 1], c[i]); for (let t = 100; t < d; t += 100) add([c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t / d, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t / d]); }
        }
      }
    }
    const boros = [];
    for (const f of boro.features || []) for (const poly of polys(f.geometry)) {
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const [x, y] of poly[0]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      boros.push({ name: f.properties?.boroname || "", poly, box: [minX, minY, maxX, maxY] });
    }
    if (segs.length < 1000) throw new Error(`only ${segs.length} truck segments loaded`);
    Object.assign(state, { segs, nodes, adj, grid, ngrid, boros, status: "ready", builtAt: new Date().toISOString(), source,
      asOf: meta?.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null,
      stats: { source, segments: segs.length, oneWay, nodes: nodes.length, miles: Math.round(segs.reduce((x, y) => x + y.len, 0) / 1609), boroughs: boros.length,
        byType: segs.reduce((o, x) => ((o[x.type] = (o[x.type] || 0) + 1), o), {}) } });
    console.log("truck network ready:", state.stats);
  } catch (e) { state.status = "error"; state.error = e.message; console.error("truck network:", e.message); setTimeout(build, 10 * 60 * 1000).unref(); }
}
function start() { build(); setInterval(build, 7 * 864e5).unref(); }

// ---------- geometry helpers ----------
function inPoly(p, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function boroAt(p) {
  for (const b of state.boros) {
    if (p[0] < b.box[0] || p[0] > b.box[2] || p[1] < b.box[1] || p[1] > b.box[3]) continue;
    if (inPoly(p, b.poly[0]) && !b.poly.slice(1).some((h) => inPoly(p, h))) return b.name;
  }
  return null;
}
// Road names written the same way for both data sources ("Brooklyn-Queens Expressway" = "BROOKLYN QUEENS EXPRESSWAY")
const normName = (n) => String(n || "").toUpperCase().replace(/\bEXPY\b|\bEXPWY\b/g, "EXPRESSWAY").replace(/\bPKWY\b/g, "PARKWAY").replace(/\bBR\b|\bBRG\b/g, "BRIDGE")
  .replace(/\bAVE?\b/g, "AVENUE").replace(/\bST\b/g, "STREET").replace(/\bBLVD\b/g, "BOULEVARD").replace(/Z+/g, "Z").replace(/[^A-Z0-9]/g, "");
function nearSegNamed(p, maxM, name) {
  const want = normName(name); if (!want || want.length < 5) return null;
  let best = null;
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), r = Math.ceil(maxM / 170), seen = new Set();
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (const id of state.grid.get(`${cx + dx}|${cy + dy}`) || []) {
    if (seen.has(id)) continue; seen.add(id);
    const s = state.segs[id], sn = normName(s.street);
    if (!(sn.includes(want) || want.includes(sn)) || sn.length < 5) continue;
    for (const q of s.c) { const d = distM(p, q); if (d <= maxM && (!best || d < best.d)) best = { d, seg: s }; }
    const c = s.c; // also distance to the line between vertices
    for (let i = 1; i < c.length; i++) {
      const A = c[i - 1], B = c[i], ax = (B[0] - A[0]) * KX, ay = (B[1] - A[1]) * KY, px = (p[0] - A[0]) * KX, py = (p[1] - A[1]) * KY;
      const L = ax * ax + ay * ay, t = L ? Math.max(0, Math.min(1, (px * ax + py * ay) / L)) : 0, d = Math.hypot(px - t * ax, py - t * ay);
      if (d <= maxM && (!best || d < best.d)) best = { d, seg: s };
    }
  }
  return best;
}
function nearSeg(p, maxM) {
  let best = null;
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), r = Math.ceil(maxM / 170);
  const seen = new Set();
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    for (const id of state.grid.get(`${cx + dx}|${cy + dy}`) || []) {
      if (seen.has(id)) continue; seen.add(id);
      const c = state.segs[id].c;
      for (let i = 1; i < c.length; i++) {
        const A = c[i - 1], B = c[i];
        const ax = (B[0] - A[0]) * KX, ay = (B[1] - A[1]) * KY, px = (p[0] - A[0]) * KX, py = (p[1] - A[1]) * KY;
        const L = ax * ax + ay * ay, t = L ? Math.max(0, Math.min(1, (px * ax + py * ay) / L)) : 0;
        const d = Math.hypot(px - t * ax, py - t * ay);
        if (d <= maxM && (!best || d < best.d)) best = { d, seg: state.segs[id], brg: bearing(A, B) };
      }
    }
  }
  return best;
}
function nearNodes(p, maxM, n = 4) {
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), r = Math.ceil(maxM / 170), out = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++)
    for (const i of state.ngrid.get(`${cx + dx}|${cy + dy}`) || []) { const d = distM(p, state.nodes[i]); if (d <= maxM) out.push({ i, d }); }
  return out.sort((a, b) => a.d - b.d).slice(0, n);
}

// ---------- path on the truck network ----------
function heapPush(h, x) { h.push(x); let i = h.length - 1; while (i) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } }
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } }
  return top;
}
function netPath(from, to, okBoros, avoidRe, penal) {
  const src = nearNodes(from, 1500), dst = nearNodes(to, 1500);
  if (!src.length || !dst.length) return null;
  const goal = new Map(dst.map((x) => [x.i, x.d]));
  const dist = new Map(), prev = new Map(), h = [];
  for (const s of src) { dist.set(s.i, s.d * 2); heapPush(h, [s.d * 2, s.i]); }
  let end = null, endCost = Infinity;
  while (h.length) {
    const [d, u] = heapPop(h);
    if (d > (dist.get(u) ?? Infinity) || d >= endCost) continue;
    if (goal.has(u) && d + goal.get(u) * 2 < endCost) { endCost = d + goal.get(u) * 2; end = u; }
    for (const { id, v } of state.adj[u]) {
      const s = state.segs[id];
      if (avoidRe && avoidRe.test(s.street)) continue; // tunnel/bridge this vehicle may not use
      // City rule: crossing a borough with no stop in it -> Through routes only
      let w = s.len * (s.type === "Through" ? 1 : s.type === "Local" ? 1.15 : 1.6) * (s.fast ? 0.6 : 1) * (penal?.has(id) ? 8 : 1);
      if (s.type !== "Through" && s.boro && !okBoros.has(s.boro)) w *= 6;
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { u, id }); heapPush(h, [nd, v]); }
    }
  }
  if (end == null) return null;
  const pts = []; let v = end;
  const chain = [];
  while (prev.has(v)) { const { u, id } = prev.get(v); chain.push({ id, from: u, to: v }); v = u; }
  chain.reverse();
  for (const { id, from } of chain) { const s = state.segs[id]; const c = s.a === from ? s.c : [...s.c].reverse(); for (const p of c) if (!pts.length || distM(pts[pts.length - 1], p) > 1) pts.push(p); }
  return pts.length > 1 ? pts : null;
}
// Points along the network path every `step` meters plus just after each turn, with their direction of travel
function viaPoints(path, step) {
  const out = []; let acc = 0, next = step, lastTurn = -1e9;
  for (let i = 1; i < path.length; i++) {
    const d = distM(path[i - 1], path[i]);
    if (i > 1 && d > 40 && acc - lastTurn > 250) {
      const b0 = bearing(path[i - 2], path[i - 1]), b1 = bearing(path[i - 1], path[i]), turn = Math.abs(((b1 - b0 + 540) % 360) - 180);
      if (turn > 35) { const t = 30 / d; out.push({ p: [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t], brg: Math.round(b1), at: acc + 30 }); lastTurn = acc; if (next - acc < 200) next += step; }
    }
    while (acc + d >= next) {
      const t = (next - acc) / d, p = [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t];
      out.push({ p, brg: Math.round(bearing(path[i - 1], path[i])), at: next });
      next += step;
    }
    acc += d;
  }
  return { pts: out, total: acc };
}

// ---------- crossings with official hazmat / height rules ----------
// MTA: all hazmat prohibited in Queens-Midtown and Hugh L. Carey tunnels; both 12'1" high (mta.info).
// Port Authority: hazmat restricted in Holland and Lincoln tunnels and on the GWB lower level.
// FDNY (FMCSA hazmat route registry): explosives prohibited on the Verrazzano-Narrows Bridge.
// "box" is the underwater/over-water part, so it's only matched where the route is outside every borough's land.
const CROSSINGS = [
  { key: "qmt", name: "Queens-Midtown Tunnel", re: /QUEENS.?MIDTOWN/i, box: [-73.972, 40.741, -73.947, 40.751], hazmat: true, maxH: 12 + 1 / 12 },
  { key: "carey", name: "Hugh L. Carey Tunnel", re: /HUGH L\.? CAREY|BROOKLYN.?BATTERY/i, box: [-74.019, 40.689, -73.999, 40.704], hazmat: true, maxH: 12 + 1 / 12 },
  { key: "holland", name: "Holland Tunnel", re: /HOLLAND TUNNEL/i, box: [-74.036, 40.722, -74.011, 40.732], hazmat: true },
  { key: "lincoln", name: "Lincoln Tunnel", re: /LINCOLN TUNNEL/i, box: [-74.026, 40.756, -73.999, 40.768], hazmat: true },
  { key: "gwblower", name: "George Washington Bridge lower level", re: /GEORGE WASHINGTON.*LOWER|LOWER LEVEL/i, box: null, hazmat: true },
  { key: "verrazzano", name: "Verrazzano-Narrows Bridge", re: /VERRAZ+ANO/i, box: [-74.056, 40.598, -74.033, 40.616], explosives: true },
];
const inBox = (p, b) => b && p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
function crossingsUsed(coords, steps) {
  const used = new Set();
  for (const s of steps || []) for (const c of CROSSINGS) if (c.re.test(`${s.name || ""} ${s.ref || ""}`)) used.add(c.key);
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    for (const c of CROSSINGS) if (!used.has(c.key) && inBox(p, c.box) && !boroAt(p)) used.add(c.key);
  }
  return CROSSINGS.filter((c) => used.has(c.key));
}
function banned(veh) {
  return CROSSINGS.filter((c) => (veh.hz && c.hazmat) || (veh.hz === 2 && c.explosives) || (c.maxH && veh.h && veh.h > c.maxH - 0.01));
}
function whyBanned(c, veh) {
  if (veh.hz === 2 && c.explosives) return `${c.name}: explosives prohibited (FDNY)`;
  if (veh.hz && c.hazmat) return `${c.name}: hazardous materials prohibited`;
  return `${c.name}: ${Math.floor(c.maxH)}'${Math.round((c.maxH % 1) * 12)}" clearance, your truck is too tall`;
}

// ---------- check a route against the official network ----------
const PARKWAY = /\b(PARKWAY|PKWY|FDR DRIVE|HARLEM RIVER DRIVE|HENRY HUDSON|HUTCHINSON|BRONX RIVER|MOSHOLU|BELT|CROSS ISLAND|GRAND CENTRAL|JACKIE ROBINSON|KOREAN WAR|LAURELTON)\b/i;
function check(coords, steps) {
  const ALLOW = 600; // leaving a truck route for the stop: nearest intersection, most direct route
  const cum = [0]; for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distM(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1] || 1;
  const nameAt = (d) => { let n = ""; for (const s of steps || []) { if (s.at <= d) n = s.name || s.ref || n; else break; } return n; };
  let nyc = 0, on = 0, i = 0, cur = null;
  const off = [], used = new Map(), boros = new Set(), restr = new Set();
  for (let d = 0; d <= total; d += 20) {
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const seg = cum[i + 1] - cum[i] || 1, t = Math.min(1, (d - cum[i]) / seg);
    const p = [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
    const b = boroAt(p);
    if (!b) { cur = null; continue; } // outside NYC, or over water on a bridge/tunnel
    nyc++; boros.add(b);
    // City maps draw one center line; real expressways and bridges have separate roadways up to ~50 m apart.
    // So: close to any truck segment, or on a highway/bridge/tunnel truck segment with the same road name nearby.
    let hit = nearSeg(p, 28);
    if (!hit) { const nm = nameAt(d); if (nm) hit = nearSegNamed(p, 90, nm); }
    if (!hit) { const h2 = nearSeg(p, 60); if (h2 && h2.seg.fast) hit = h2; }
    if (hit) { on++; if (cur && d - cur.to > 60) cur = null; used.set(hit.seg.type, (used.get(hit.seg.type) || 0) + 20); if (hit.seg.restr) restr.add(`${hit.seg.street}: ${hit.seg.restr}`); if (hit.seg.ltd) restr.add(`${hit.seg.street}: Limited Local (${hit.seg.ltd})`); continue; }
    const allowed = d < ALLOW || total - d < ALLOW;
    if (cur && cur.allowed === allowed && d - cur.to <= 60) { cur.to = Math.round(d + 20); continue; }
    if (!cur || cur.allowed !== allowed) { cur = { from: Math.round(d), to: Math.round(d), allowed, street: nameAt(d), boro: b }; off.push(cur); }
    cur.to = Math.round(d + 20);
  }
  const bad = off.filter((o) => !o.allowed && o.to - o.from >= 80);
  const parkways = [...new Set((steps || []).map((s) => s.name || "").filter((n) => PARKWAY.test(n) && !/EASTERN PARKWAY|OCEAN PARKWAY|PELHAM PARKWAY/i.test(n)))];
  const pct = nyc ? Math.round((on / nyc) * 1000) / 10 : null;
  return {
    inNYC: nyc > 0, pctOnNetwork: pct, boroughs: [...boros],
    offRoute: bad.map((o) => ({ street: nameAt((o.from + o.to) / 2) || o.street || "unnamed street", meters: o.to - o.from, borough: o.boro, at: o.from })),
    endsOffNetwork: off.filter((o) => o.allowed).reduce((s, o) => s + (o.to - o.from), 0),
    parkways, notes: [...restr].slice(0, 8),
    verdict: !nyc ? "outside" : bad.length || parkways.length ? "warn" : "ok",
  };
}

// ---------- the truck route ----------
const recentErrors = [], testRuns = new Map(), recentRuns = [];
// Last real driver requests (rounded points, no identity) so problems can be traced
function logRun(pts, veh, r, out, t0, err) {
  recentRuns.unshift({ t: new Date().toISOString(), pts: pts.map((p) => p.map((x) => Math.round(x * 1000) / 1000)), veh,
    mi: r ? Math.round(r.route.distance / 160.9) / 10 : null, min: r ? Math.round(r.route.duration / 60) : null, verdict: r?.compliance?.verdict, err: err?.message,
    secs: (Date.now() - t0) / 1000, attempts: (out.attempts || []).map((a) => ({ ...a, streets: undefined })) });
  recentRuns.length = Math.min(recentRuns.length, 15);
}
function logErr(m) { console.error(m); recentErrors.unshift({ t: new Date().toISOString(), m: String(m).slice(0, 300) }); recentErrors.length = Math.min(recentErrors.length, 20); }
async function osrm(points, keepIdx) {
  const coords = points.map((x) => `${x.p[0].toFixed(6)},${x.p[1].toFixed(6)}`).join(";");
  for (const host of OSRM_HOSTS) {
    try { return await osrmOn(host, coords, points, keepIdx); }
    catch (e) { if (e.final) throw e; logErr(`route engine ${host.split("/")[2]}: ${e.message}`); }
  }
  throw new Error("Route servers are busy. Try again in a minute.");
}
async function osrmOn(host, coords, points, keepIdx) {
  const core = `${host}/${coords}?overview=full&geometries=geojson&steps=true`;
  const hasVia = points.some((x, i) => x.brg != null && !keepIdx.includes(i));
  const bearings = points.map((x, i) => (x.brg != null && !keepIdx.includes(i) ? `${Math.round(x.brg) % 360},60` : "")).join(";");
  // From richest to plainest. If the engine rejects an option ("InvalidQuery"), drop it and try again.
  const tries = [
    hasVia ? `${core}&annotations=maxspeed&continue_straight=true&bearings=${bearings}` : null,
    hasVia ? `${core}&continue_straight=true&bearings=${bearings}` : null,
    `${core}&annotations=maxspeed&continue_straight=true`,
    `${core}&annotations=maxspeed`,
    `${core}&continue_straight=true`,
    core,
  ].filter(Boolean);
  let last = "NoRoute";
  for (let k = 0; k < tries.length; k++) {
    try {
      const r = await fetch(tries[k], { signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({ code: `HTTP ${r.status}` }));
      if (j.code === "Ok" && j.routes?.length) return normalize(j.routes[0], points.length, keepIdx);
      last = j.message ? `${j.code}: ${j.message}` : j.code || `HTTP ${r.status}`;
      console.error("truck route engine:", last, "| try", k);
      if (j.code === "NoRoute" || j.code === "NoSegment") throw Object.assign(new Error("No route found between these places"), { final: true });
    } catch (e) { if (e.final) throw e; last = e.message; if (/fetch failed|timed? ?out|abort/i.test(last)) break; }
  }
  throw new Error(last);
}
const TT_MAN = {
  DEPART: ["depart"], ARRIVE: ["arrive"], ARRIVE_LEFT: ["arrive"], ARRIVE_RIGHT: ["arrive"],
  STRAIGHT: ["continue", "straight"], FOLLOW: ["continue", "straight"], SWITCH_MAIN_ROAD: ["continue", "straight"], SWITCH_PARALLEL_ROAD: ["continue", "straight"],
  KEEP_LEFT: ["fork", "slight left"], KEEP_RIGHT: ["fork", "slight right"], BEAR_LEFT: ["turn", "slight left"], BEAR_RIGHT: ["turn", "slight right"],
  TURN_LEFT: ["turn", "left"], TURN_RIGHT: ["turn", "right"], SHARP_LEFT: ["turn", "sharp left"], SHARP_RIGHT: ["turn", "sharp right"],
  MAKE_UTURN: ["turn", "uturn"], TRY_MAKE_UTURN: ["turn", "uturn"], ENTER_MOTORWAY: ["on ramp", "slight right"], ENTER_FREEWAY: ["on ramp", "slight right"],
  ENTER_HIGHWAY: ["on ramp", "slight right"], ENTRANCE_RAMP: ["on ramp", "slight right"], TAKE_EXIT: ["off ramp", "slight right"],
  MOTORWAY_EXIT_LEFT: ["off ramp", "slight left"], MOTORWAY_EXIT_RIGHT: ["off ramp", "slight right"], TAKE_FERRY: ["continue", "straight"],
  ROUNDABOUT_CROSS: ["roundabout", "straight"], ROUNDABOUT_RIGHT: ["roundabout", "right"], ROUNDABOUT_LEFT: ["roundabout", "left"], ROUNDABOUT_BACK: ["roundabout", "uturn"],
};
async function tomtom(points, keepIdx, veh = {}, alts = 0) {
  const loc = points.map((x) => `${x.p[1].toFixed(6)},${x.p[0].toFixed(6)}`).join(":");
  const q = new URLSearchParams({ key: TOMTOM_KEY, travelMode: veh.car ? "car" : "truck", traffic: "true", routeType: "fastest",
    instructionsType: "text", language: "en-US", routeRepresentation: "polyline" });
  if (!veh.car) q.set("vehicleCommercial", "true");
  if (veh.car) veh = {}; // plain car route: used only to spot crazy truck detours
  if (veh.h) q.set("vehicleHeight", (veh.h * 0.3048).toFixed(2));
  if (veh.w) q.set("vehicleWeight", String(Math.round(veh.w * 0.4536)));
  if (veh.l) q.set("vehicleLength", (veh.l * 0.3048).toFixed(2));
  if (!veh.car && Object.keys(veh).length) q.set("vehicleWidth", "2.59"); // 8'6" standard width
  if (veh.axles) q.set("vehicleNumberOfAxles", String(veh.axles));
  if (alts) q.set("maxAlternatives", String(alts));
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${loc}/json?${q}${veh.hzc ? `&vehicleLoadType=USHazmatClass${veh.hzc}` : ""}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.routes?.length) throw new Error(j.error?.description || j.detailedError?.message || `TomTom ${r.status}`);
  return alts ? j.routes.map((rt) => fromTomTom(rt, points, keepIdx)) : fromTomTom(j.routes[0], points, keepIdx);
}
// TomTom answer -> the same shape the app already understands (legs split only at real stops)
function fromTomTom(rt, points, keepIdx) {
  const coords = [];
  for (const lg of rt.legs || []) for (const p of lg.points || []) { const c = [p.longitude, p.latitude], l = coords[coords.length - 1]; if (!l || l[0] !== c[0] || l[1] !== c[1]) coords.push(c); }
  const ins = rt.guidance?.instructions || [], total = rt.summary.lengthInMeters, ttot = rt.summary.travelTimeInSeconds;
  const newLeg = () => ({ steps: [], distance: 0, duration: 0, annotation: { maxspeed: [] } });
  const legs = [newLeg()];
  let wp = 0;
  ins.forEach((x, i) => {
    const nx = ins[i + 1], dist = Math.max(0, (nx ? nx.routeOffsetInMeters : total) - x.routeOffsetInMeters), dur = Math.max(0, (nx ? nx.travelTimeInSeconds : ttot) - x.travelTimeInSeconds);
    const loc = x.point ? [x.point.longitude, x.point.latitude] : null, m = x.maneuver || "";
    if (/^WAYPOINT/.test(m)) {
      wp++;
      const L = legs[legs.length - 1];
      if (!keepIdx.includes(wp)) { if (L.steps.length) { L.steps[L.steps.length - 1].distance += dist; L.steps[L.steps.length - 1].duration += dur; } return; } // silent via point
      L.steps.push({ distance: 0, duration: 0, name: "", maneuver: { type: "arrive", location: loc }, intersections: [{ location: loc }] });
      legs.push(newLeg());
      legs[legs.length - 1].steps.push({ distance: dist, duration: dur, name: x.street || "", ref: (x.roadNumbers || [])[0] || "", maneuver: { type: "depart", location: loc }, intersections: [{ location: loc }] });
      return;
    }
    const [type, modifier] = TT_MAN[m] || ["continue", "straight"];
    legs[legs.length - 1].steps.push({ distance: dist, duration: dur, name: x.street || "", ref: (x.roadNumbers || []).join(";"), destinations: x.signpostText || undefined, exits: x.exitNumber || undefined,
      maneuver: { type, modifier, location: loc, exit: x.roundaboutExitNumber || undefined, bearing_after: 0 }, intersections: [{ location: loc }] });
  });
  for (const L of legs) { L.distance = L.steps.reduce((s, x) => s + x.distance, 0); L.duration = L.steps.reduce((s, x) => s + x.duration, 0); }
  return { geometry: { coordinates: coords }, distance: total, duration: ttot, legs, live: true, trafficDelay: rt.summary.trafficDelayInSeconds || 0, engine: "tomtom" };
}
// One leg per real stop (via points are silent even if the engine split legs at them)
function normalize(rt, n, keepIdx) {
  if (rt.legs.length === keepIdx.length - 1) return rt;
  const bounds = keepIdx.slice(1, -1), legs = []; let cur = null;
  rt.legs.forEach((lg, li) => {
    if (!cur) cur = { steps: [], distance: 0, duration: 0, annotation: { maxspeed: [] } };
    let st = lg.steps;
    if (cur.steps.length) st = st.filter((s) => s.maneuver.type !== "depart");
    const endsHere = li === rt.legs.length - 1 || bounds.includes(li + 1);
    if (!endsHere) st = st.filter((s) => s.maneuver.type !== "arrive");
    cur.steps.push(...st); cur.distance += lg.distance; cur.duration += lg.duration;
    cur.annotation.maxspeed.push(...(lg.annotation?.maxspeed || []));
    if (endsHere) { legs.push(cur); cur = null; }
  });
  return { ...rt, legs };
}
function stepsAt(rt) { let acc = 0; return rt.legs.flatMap((l) => l.steps).map((s) => { const x = { ...s, at: acc }; acc += s.distance; return x; }); }

// Hazmat + official clearance rules on top of the truck-network check
function addRules(c, rt, veh, stops) {
  const used = crossingsUsed(rt.geometry.coordinates, stepsAt(rt));
  const blocked = used.filter((x) => banned(veh).some((b) => b.key === x.key)).map((x) => whyBanned(x, veh));
  const hz = { on: !!veh.hz, explosives: veh.hz === 2, blocked, avoided: [], notes: [] };
  if (veh.hz) {
    hz.avoided = CROSSINGS.filter((x) => banned(veh).some((b) => b.key === x.key) && !used.some((u) => u.key === x.key)).map((x) => x.name);
    const through = c.inNYC && stops.every((p) => !boroAt(p));
    if (through) hz.notes.push(veh.hz === 2 ? "Passing through NYC with explosives: only 10 AM–3 PM and 7 PM–6 AM on weekdays, with FDNY authorization and escort." : "Passing through NYC without a stop: weekdays only 9 AM–4 PM and 6 PM–7 AM (FDNY).");
    hz.notes.push("FDNY permits apply to many hazardous materials in NYC. Carry your permit and shipping papers.");
    if (used.some((u) => u.key === "gwblower") || /GEORGE WASHINGTON/i.test(stepsAt(rt).map((s) => s.name).join(" "))) hz.notes.push("On the George Washington Bridge use the UPPER level (hazmat is restricted on the lower level).");
  }
  const verdict = blocked.length ? "warn" : c.verdict;
  return { ...c, verdict, blocked, hazmat: hz, entry: rt.entryName || null };
}
// Ways into NYC that FDNY's hazmat routes use, tried when the direct way in uses a banned crossing
const ENTRY = [{ name: "George Washington Bridge (upper level)", p: [-73.9527, 40.8517] }, { name: "Goethals Bridge", p: [-74.1975, 40.6356] },
  { name: "Bayonne Bridge", p: [-74.1422, 40.6421] }, { name: "Outerbridge Crossing", p: [-74.2296, 40.5246] }, { name: "Throgs Neck Bridge", p: [-73.7942, 40.8007] }];
const BUDGET = 22000; // answer within ~25 s with the best verified route so far
async function truckRoute(stops, veh = {}, out = {}) {
  const t0 = Date.now(), timeLeft = () => BUDGET - (Date.now() - t0);
  const engine = TOMTOM_KEY ? (pts, keep) => tomtom(pts, keep, veh).catch((e) => { logErr("TomTom: " + e.message); return osrm(pts, keep); }) : osrm;
  if (state.status !== "ready" && state.status !== "loading") build(); // nationwide routing works meanwhile; NYC check needs the city map
  const okBoros = new Set(stops.map(boroAt).filter(Boolean));
  const ban = banned(veh), banKeys = new Set(ban.map((c) => c.key));
  const avoidRe = ban.length ? new RegExp(ban.map((c) => c.re.source).join("|"), "i") : null;
  // plain route first: where does the trip enter and leave NYC?
  // Ask for alternatives too: the "fastest" truck route can backtrack miles to save a minute; drivers want the sensible one.
  const P = stops.map((p) => ({ p })), K = stops.map((_, i) => i);
  // For heavy trucks also ask (at the same time) for the route without weight/axle limits, to catch huge detours
  const lightP = TOMTOM_KEY ? tomtom(P, K, { car: true }).catch((e) => { logErr("TomTom car check: " + e.message); return null; }) : null;
  let cands;
  if (TOMTOM_KEY) cands = await tomtom(P, K, veh, 2).catch((e) => { logErr("TomTom: " + e.message); return null; });
  if (!cands) cands = [await osrm(P, K)];
  const offOf = (c) => c.offRoute.reduce((a, o) => a + o.meters, 0) + c.parkways.length * 5000 + (c.blocked?.length || 0) * 50000;
  const scored = cands.map((rt) => {
    const c = addRules(check(rt.geometry.coordinates, stepsAt(rt)), rt, veh, stops);
    const off = offOf(c);
    // each extra mile ~ 73 s (don't drive 5 extra miles to save 2 minutes); each meter off the truck network ~ 1.5 s
    return { rt, c, off, cost: rt.duration + rt.distance / 22 + off * 1.5 };
  });
  const minOff = Math.min(...scored.map((x) => x.off));
  const pick = scored.filter((x) => x.off <= minOff + 1000).sort((a, b) => a.cost - b.cost)[0]; // never a route with long illegal stretches
  // Heavy-truck sanity: TomTom sometimes sends an 80,000 lb / 5-axle truck 100+ miles around for one marked weight limit
  // (a single bridge or a closure). If dropping weight/axles gives a far shorter route, use it and keep the long one as an option.
  const crow0 = stops.slice(1).reduce((d, p, i) => d + distM(stops[i], p), 0);
  if (lightP && pick.rt.engine === "tomtom" && pick.rt.distance > crow0 * 1.5 + 8000) {
    const light = await lightP;
    const lc0 = light && addRules(check(light.geometry.coordinates, stepsAt(light)), light, veh, stops);
    const noParkway = light && !stepsAt(light).some((x) => /PARKWAY|PKWY|\bPKY\b|SKYWAY/i.test(`${x.name || ""} ${x.ref || ""}`));
    if (light && noParkway && !lc0.blocked?.length && offOf(lc0) <= pick.off + 1000 && light.distance * 1.35 < pick.rt.distance && pick.rt.distance - light.distance > 24000) {
      const mi = (m) => Math.round(m / 1609);
      out.heavyAlt = { route: pick.rt, compliance: { ...pick.c, notes: [`Restriction-safe route (${mi(pick.rt.distance)} mi): avoids every road marked with a truck limit or closure for your truck.`, ...(pick.c.notes || [])] } };
      const lc = lc0;
      lc.notes = [`Direct route. The truck map marks a limit or closure somewhere on the direct roads that would add ${mi(pick.rt.distance - light.distance)} mi. Watch for posted truck signs and detours, or tap the ${mi(pick.rt.distance)} mi restriction-safe route.`, ...(lc.notes || [])];
      (out.attempts ||= []).push({ pass: "heavy-check", heavyMi: mi(pick.rt.distance), directMi: mi(light.distance) });
      pick.rt = light; pick.c = lc;
    }
  }
  let plain = pick.rt, entry = null;
  // Sanity limits: nothing Rova adds on top of the engine's route may make it much longer
  const base = { route: pick.rt, compliance: pick.c }, baseDist = pick.rt.distance;
  const crow = stops.slice(1).reduce((d, p, i) => d + distM(stops[i], p), 0);
  const maxDist = Math.max(baseDist * 1.25, baseDist + 5000);
  if (baseDist > crow * 2.5 + 15000) pick.c.notes = [`Long way around (${Math.round(baseDist / 1609)} mi): your truck's height, weight or length rules out the direct roads. Check your truck settings.`, ...(pick.c.notes || [])];
  (out.attempts ||= []).push({ pass: "plain", engine: plain.engine || "basic", options: scored.map((x) => ({ mi: Math.round(x.rt.distance / 160.9) / 10, min: Math.round(x.rt.duration / 60), offM: x.off, picked: x === pick, via: [...new Set(stepsAt(x.rt).map((s) => s.name).filter(Boolean))].slice(0, 6).join(" > ") })), secs: (Date.now() - t0) / 1000 });
  // TomTom already follows truck restrictions nationwide: if NYC's own network check passes too, we're done
  {
    const c0 = pick.c;
    out.best = { route: plain, compliance: c0 }; // always have an answer ready
    if (plain.engine === "tomtom" && (c0.verdict === "ok" || c0.verdict === "outside")) return out.best;
  }
  if (ban.length && crossingsUsed(plain.geometry.coordinates, stepsAt(plain)).some((c) => banKeys.has(c.key))) {
    // the direct way uses a banned tunnel/bridge: try the official ways in and keep the shortest legal one
    let best = null;
    const tries = await Promise.all(ENTRY.map(async (e) => { // all at once, not one by one
      try {
        const pts = [{ p: stops[0] }, { p: e.p }, ...stops.slice(1).map((p) => ({ p }))];
        return { e, rt: await engine(pts, [0, ...stops.slice(1).map((_, i) => i + 2)]) };
      } catch { return null; }
    }));
    for (const t of tries) if (t && t.rt.distance <= Math.max(baseDist * 1.6, baseDist + 15000) && !crossingsUsed(t.rt.geometry.coordinates, stepsAt(t.rt)).some((c) => banKeys.has(c.key)) && (!best || t.rt.distance < best.distance)) { best = t.rt; entry = t.e; }
    if (best) { plain = best; out.best = { route: plain, compliance: addRules(check(plain.geometry.coordinates, stepsAt(plain)), plain, veh, stops) }; }
  }
  const pc = plain.geometry.coordinates;
  const firstIn = pc.find((p) => boroAt(p)), lastIn = [...pc].reverse().find((p) => boroAt(p));
  if (!firstIn) return { route: plain, compliance: addRules({ ...check(pc, stepsAt(plain)), verdict: "outside" }, plain, veh, stops) };
  // build the network path leg by leg, then thread the route through it
  let legs = [];
  (out.attempts ||= []).push({ pass: "network", firstIn, lastIn });
  for (let k = 1; k < stops.length; k++) {
    const a = k === 1 && !boroAt(stops[0]) ? firstIn : stops[k - 1], b = k === stops.length - 1 && !boroAt(stops[k]) ? lastIn : stops[k];
    const path = netPath(a, b, okBoros, avoidRe);
    legs.push({ a, b, path });
    out.attempts.push({ pass: "netPath", leg: k, found: !!path, km: path ? Math.round(path.reduce((d, p, i) => (i ? d + distM(path[i - 1], p) : 0), 0) / 100) / 10 : 0,
      streets: path ? [...new Set(path.map((p) => nearSeg(p, 5)?.seg.street).filter(Boolean))].slice(0, 25) : [] });
  }
  const make = (step, L = legs) => {
    const pts = [{ p: stops[0] }], keep = [0];
    if (entry && !boroAt(stops[0])) pts.push({ p: entry.p }); // stay on the legal bridge we picked
    L.forEach(({ a, b, path }, j) => {
      if (a !== stops[j]) pts.push({ p: a });
      if (path) for (const v of viaPoints(path, step).pts) pts.push(v);
      if (b !== stops[j + 1]) pts.push({ p: b });
      pts.push({ p: stops[j + 1] }); keep.push(pts.length - 1);
    });
    return { pts, keep };
  };
  const offM = (c) => c.offRoute.reduce((s, o) => s + o.meters, 0) + c.parkways.length * 5000 + (c.blocked?.length || 0) * 50000;
  let best = out.best;
  const maxPts = plain.engine === "tomtom" ? 140 : 95;
  for (const step of [600, 300]) {
    if (timeLeft() < (step === 600 ? 6000 : 9000)) break; // not enough time for another full pass
    let { pts, keep } = make(step);
    if (pts.length > maxPts) { if (step !== 600) break; ({ pts, keep } = make(1200)); if (pts.length > maxPts) break; }
    try {
      const rt = await engine(pts, keep), c = addRules(check(rt.geometry.coordinates, stepsAt(rt)), rt, veh, stops);
      (out.attempts ||= []).push({ pass: step, points: pts.length, engine: rt.engine || "basic", pct: c.pctOnNetwork, offM: offM(c), off: c.offRoute.map((o) => `${o.street} ${o.meters}m`), secs: (Date.now() - t0) / 1000 });
      if ((!best || offM(c) < offM(best.compliance)) && rt.distance <= Math.min(plain.distance * 1.15, maxDist)) { best = { route: rt, compliance: c }; out.best = best; } // never trade a few flagged blocks for a big detour
    } catch (e) { (out.attempts ||= []).push({ pass: step, points: pts.length, error: e.message }); }
    if (best && best.compliance.verdict === "ok") break;
  }
  // Still leaving the truck network? Usually a turn that's banned for trucks: avoid those spots and re-plan once.
  if (best && best.compliance.offRoute.length && timeLeft() > 7000) {
    const rc = best.route.geometry.coordinates, cum = [0];
    for (let i = 1; i < rc.length; i++) cum.push(cum[i - 1] + distM(rc[i - 1], rc[i]));
    const at = (d) => { let i = 0; while (i < cum.length - 2 && cum[i + 1] < d) i++; return rc[i]; };
    const penal = new Set();
    for (const o of best.compliance.offRoute) for (const d of [o.at - 60, o.at, o.at + o.meters / 2]) {
      const p = at(Math.max(0, d)), cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const id of state.grid.get(`${cx + x}|${cy + y}`) || []) {
        if (state.segs[id].c.some((q) => distM(q, p) < 150)) penal.add(id);
      }
    }
    const legs2 = legs.map(({ a, b }) => ({ a, b, path: netPath(a, b, okBoros, avoidRe, penal) }));
    const { pts, keep } = make(300, legs2);
    if (pts.length <= maxPts) {
      try {
        const rt = await engine(pts, keep), c = addRules(check(rt.geometry.coordinates, stepsAt(rt)), rt, veh, stops);
        out.attempts.push({ pass: "avoid-turns", points: pts.length, penalized: penal.size, pct: c.pctOnNetwork, offM: offM(c), off: c.offRoute.map((o) => `${o.street} ${o.meters}m`), secs: (Date.now() - t0) / 1000 });
        if (offM(c) < offM(best.compliance) && rt.distance <= Math.min(plain.distance * 1.15, maxDist)) { best = { route: rt, compliance: c }; out.best = best; }
      } catch (e) { out.attempts.push({ pass: "avoid-turns", error: e.message }); }
    }
  }
  if (!best || best.route.distance > Math.max(maxDist, baseDist * 1.6, baseDist + 15000)) { out.attempts.push({ pass: "sanity", fellBackTo: "engine route" }); out.best = base; return base; }
  return best;
}

function routes(url, res, send, readBody, req) {
  if (url.pathname === "/api/truck/tt") { // probe: one TomTom request, summary only
    const pts = [url.searchParams.get("from"), url.searchParams.get("to")].map((x) => (x || "").split(",").map(Number));
    const n = (k) => +url.searchParams.get(k) || 0;
    const veh = url.searchParams.get("mode") === "car" ? { car: true } : { h: n("h"), w: n("w"), l: n("l"), axles: n("ax"), hzc: n("hzc") };
    const id = Math.random().toString(36).slice(2, 10); testRuns.set(id, { status: "running" });
    tomtom(pts.map((p) => ({ p })), [0, 1], veh).then((rt) => testRuns.set(id, { status: "done", mi: Math.round(rt.distance / 160.9) / 10, min: Math.round(rt.duration / 60), roads: [...new Set(stepsAt(rt).map((x) => x.name).filter(Boolean))].slice(0, 20) }))
      .catch((e) => testRuns.set(id, { status: "error", error: e.message }));
    send(res, 200, { id }); return true;
  }
  if (url.pathname === "/api/truck/recent") { send(res, 200, { runs: recentRuns }); return true; }
  if (url.pathname === "/api/truck/status") {
    send(res, 200, { status: state.status, error: state.error, asOf: state.asOf, builtAt: state.builtAt, stats: state.stats, tomtom: !!TOMTOM_KEY, recentErrors });
    return true;
  }
  if (url.pathname === "/api/truck/network") {
    const [w, s, e, n] = ["w", "s", "e", "n"].map((k) => +url.searchParams.get(k));
    if (state.status !== "ready" || ![w, s, e, n].every(isFinite) || e - w > 0.5 || n - s > 0.5) { send(res, 200, { type: "FeatureCollection", features: [], status: state.status, asOf: state.asOf }); return true; }
    const seen = new Set(), feats = [];
    for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++)
      for (const id of state.grid.get(`${x}|${y}`) || []) {
        if (seen.has(id)) continue; seen.add(id);
        const g = state.segs[id];
        feats.push({ type: "Feature", properties: { t: g.type, s: g.street }, geometry: { type: "LineString", coordinates: g.c.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]) } });
        if (feats.length > 6000) break;
      }
    send(res, 200, { type: "FeatureCollection", features: feats, asOf: state.asOf }, "application/json", "public, max-age=3600");
    return true;
  }
  if (url.pathname === "/api/truck/test") {
    const id = url.searchParams.get("id");
    if (id) { send(res, 200, testRuns.get(id) || { status: "unknown id" }); return true; }
    const pts = (url.searchParams.get("pts") || [url.searchParams.get("from"), url.searchParams.get("to")].filter(Boolean).join(";")).split(/[;~]/).map((x) => x.split(",").map(Number)).filter((p) => p.length === 2 && p.every(isFinite));
    if (pts.length < 2 || pts.length > 4) { send(res, 400, { error: "bad points" }); return true; }
    const num = (k, d) => (url.searchParams.has(k) ? +url.searchParams.get(k) || 0 : d);
    const veh = { h: num("h", 13.5), w: num("w", 80000), l: num("l", 70), axles: num("ax", 5), hzc: num("hzc", 0) };
    veh.hz = veh.hzc === 1 ? 2 : veh.hzc ? 1 : 0;
    const rid = Math.random().toString(36).slice(2, 10), t0 = Date.now();
    testRuns.set(rid, { status: "running" }); if (testRuns.size > 50) testRuns.delete(testRuns.keys().next().value);
    const out2 = {};
    truckRoute(pts, veh, out2).then((r) => testRuns.set(rid, { status: "done", attempts: out2.attempts, secs: (Date.now() - t0) / 1000, engine: r.route.engine || "basic", miles: Math.round(r.route.distance / 160.9) / 10, minutes: Math.round(r.route.duration / 60),
      verdict: r.compliance.verdict, pct: r.compliance.pctOnNetwork, offRoute: r.compliance.offRoute, parkways: r.compliance.parkways, blocked: r.compliance.blocked,
      roads: [...new Set(stepsAt(r.route).map((x) => x.name).filter(Boolean))].slice(0, 40) }))
      .catch((e) => testRuns.set(rid, { status: "error", error: e.message }));
    send(res, 200, { id: rid });
    return true;
  }
  if (url.pathname === "/api/truck/route") {
    const pts = (url.searchParams.get("pts") || "").split(";").map((x) => x.split(",").map(Number)).filter((p) => p.length === 2 && p.every(isFinite));
    if (pts.length < 2 || pts.length > 4) { send(res, 400, { error: "bad points" }); return true; }
    const hzc = Math.min(9, Math.max(0, Math.round(+url.searchParams.get("hzc") || 0))), hzOld = +url.searchParams.get("hz") || 0;
    const veh = { h: Math.min(20, Math.max(0, +url.searchParams.get("h") || 0)), w: Math.min(250000, Math.max(0, +url.searchParams.get("w") || 0)), l: Math.min(150, Math.max(0, +url.searchParams.get("l") || 0)),
      axles: Math.min(12, Math.max(0, Math.round(+url.searchParams.get("ax") || 0))),
      hzc: hzc || (hzOld === 2 ? 1 : hzOld === 1 ? 3 : 0) };
    veh.hz = veh.hzc === 1 ? 2 : veh.hzc ? 1 : 0;
    const out = {};
    const timer = new Promise((ok) => setTimeout(() => ok(out.best ? { ...out.best, partial: true } : null), BUDGET + 3000));
    const job = truckRoute(pts, veh, out);
    const t0 = Date.now();
    job.then((r) => logRun(pts, veh, r, out, t0), (e) => logRun(pts, veh, null, out, t0, e));
    Promise.race([job, timer]).then((r) => r || job).then((r) => send(res, 200, { code: "Ok", routes: [r.route, ...(out.heavyAlt ? [out.heavyAlt.route] : [])], compliance: { ...r.compliance, engine: r.route.engine || "basic", asOf: state.asOf },
      altCompliance: out.heavyAlt ? { ...out.heavyAlt.compliance, engine: "tomtom", asOf: state.asOf, weightSafe: true } : undefined }))
      .catch((e) => send(res, e.code || 502, { error: e.message || "No truck route found" }));
    return true;
  }
  return false;
}

module.exports = { routes, start, check, netPath, state, crossingsUsed, banned, addRules, truckRoute, _build: build };
