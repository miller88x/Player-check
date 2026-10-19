// Truck mode: routes that stay on NYC's official Truck Route Network, checked segment by segment.
// Data: NYC DOT "New York City Truck Routes" (jjja-shxy) + DCP "Borough Boundaries" (gthc-hcne), both NYC Open Data.
// How it works:
//   1. Find a path ON the truck network (graph of official segments), following the city rules:
//      Through routes when crossing a borough with no stop in it; Local routes for trips that start/end in a borough.
//   2. Turn that path into real turn-by-turn directions (one-way streets respected) by asking the route engine
//      to pass through points along it, pointed in the direction of travel.
//   3. Check every 20 m of the final route against the official network and report anything off it.
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const OSRM = process.env.OSRM_URL || "https://router.project-osrm.org";
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

async function build() {
  if (state.status === "loading") return;
  state.status = "loading"; state.error = null;
  try {
    const [meta, net, boro] = await Promise.all([
      getJSON("https://data.cityofnewyork.us/api/views/jjja-shxy.json", 30000).catch(() => null),
      (async () => { // page through so no segment is cut off by an API row limit
        const all = [];
        for (let off = 0; off < 500000; off += 40000) {
          const j = await getJSON(`https://data.cityofnewyork.us/resource/jjja-shxy.geojson?$select=the_geom,street,routetype,boroname,ltdlocal,restrictio&$order=:id&$limit=40000&$offset=${off}`);
          all.push(...(j.features || [])); if ((j.features || []).length < 40000) break;
        }
        return { features: all };
      })(),
      getJSON("https://data.cityofnewyork.us/resource/gthc-hcne.geojson?$limit=10"),
    ]);
    const segs = [], nodes = [], nodeKey = new Map(), adj = [], grid = new Map(), ngrid = new Map();
    const node = (p) => {
      const k = `${Math.round(p[0] / 2e-5)}|${Math.round(p[1] / 2e-5)}`;
      let i = nodeKey.get(k);
      if (i == null) { i = nodes.length; nodes.push(p); nodeKey.set(k, i); adj.push([]); const c = ck(p[0], p[1]); (ngrid.get(c) || ngrid.set(c, []).get(c)).push(i); }
      return i;
    };
    for (const f of net.features || []) {
      const pr = f.properties || {};
      const type = /through/i.test(pr.routetype || "") ? "Through" : /limited/i.test(pr.routetype || "") ? "Limited Local" : "Local";
      for (const c of lines(f.geometry)) {
        if (!c || c.length < 2) continue;
        let len = 0; for (let i = 1; i < c.length; i++) len += distM(c[i - 1], c[i]);
        const id = segs.length;
        const street = String(pr.street || "").trim();
        const fast = /EXPRESSWAY|EXPWY|EXPY|HIGHWAY|HWY|INTERSTATE|TURNPIKE|BRIDGE|TUNNEL|THRUWAY/i.test(street);
        const s = { id, c, len, street, type, boro: pr.boroname || "", ltd: pr.ltdlocal || "", restr: pr.restrictio || "", fast };
        s.a = node(c[0]); s.b = node(c[c.length - 1]);
        adj[s.a].push(id); adj[s.b].push(id);
        segs.push(s);
        // index every vertex (and midpoints of long pieces) into the grid
        for (let i = 0; i < c.length; i++) {
          const add = (p) => { const k = ck(p[0], p[1]); const a = grid.get(k) || grid.set(k, []).get(k); if (a[a.length - 1] !== id) a.push(id); };
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
    Object.assign(state, { segs, nodes, adj, grid, ngrid, boros, status: "ready", builtAt: new Date().toISOString(),
      asOf: meta?.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null,
      stats: { segments: segs.length, nodes: nodes.length, miles: Math.round(segs.reduce((s, x) => s + x.len, 0) / 1609), boroughs: boros.length,
        byType: segs.reduce((o, s) => ((o[s.type] = (o[s.type] || 0) + 1), o), {}) } });
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
function netPath(from, to, okBoros) {
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
    for (const id of state.adj[u]) {
      const s = state.segs[id], v = s.a === u ? s.b : s.a;
      // City rule: crossing a borough with no stop in it -> Through routes only
      let w = s.len * (s.type === "Through" ? 1 : s.type === "Local" ? 1.15 : 1.6) * (s.fast ? 0.6 : 1);
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

// ---------- check a route against the official network ----------
const PARKWAY = /\b(PARKWAY|PKWY|FDR DRIVE|HARLEM RIVER DRIVE|HENRY HUDSON|HUTCHINSON|BRONX RIVER|MOSHOLU|BELT|CROSS ISLAND|GRAND CENTRAL|JACKIE ROBINSON|KOREAN WAR|LAURELTON|CLEARVIEW)\b/i;
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
    const hit = nearSeg(p, 28); // city centerlines and map roads can differ by a few meters on wide roads
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
async function osrm(points, keepIdx) {
  const coords = points.map((x) => `${x.p[0].toFixed(6)},${x.p[1].toFixed(6)}`).join(";");
  const base = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&annotations=maxspeed`;
  const hasVia = points.some((x, i) => x.brg != null && !keepIdx.includes(i));
  const bearings = points.map((x, i) => (x.brg != null && !keepIdx.includes(i) ? `${Math.round(x.brg) % 360},60` : "")).join(";");
  // Try with direction hints first; if the engine rejects any option, retry simpler (legs are merged below either way)
  const tries = [hasVia ? `${base}&continue_straight=true&bearings=${bearings}` : null, `${base}&continue_straight=true`, base].filter(Boolean);
  let last = "NoRoute";
  for (const url of tries) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.code === "Ok" && j.routes?.length) return normalize(j.routes[0], points.length, keepIdx);
      last = j.code || `HTTP ${r.status}`;
      if (j.code === "NoRoute" || j.code === "NoSegment") break; // a simpler request won't help
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
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

async function truckRoute(stops) {
  if (state.status !== "ready") { if (state.status !== "loading") build(); throw Object.assign(new Error("The NYC truck route map is still loading. Try again in a minute."), { code: 503 }); }
  const okBoros = new Set(stops.map(boroAt).filter(Boolean));
  // plain route first: where does the trip enter and leave NYC?
  const plain = await osrm(stops.map((p) => ({ p })), stops.map((_, i) => i));
  const pc = plain.geometry.coordinates;
  const firstIn = pc.find((p) => boroAt(p)), lastIn = [...pc].reverse().find((p) => boroAt(p));
  if (!firstIn) return { route: plain, compliance: { ...check(pc, stepsAt(plain)), verdict: "outside" } };
  // build the network path leg by leg, then thread the route through it
  const legs = [];
  for (let k = 1; k < stops.length; k++) {
    const a = k === 1 && !boroAt(stops[0]) ? firstIn : stops[k - 1], b = k === stops.length - 1 && !boroAt(stops[k]) ? lastIn : stops[k];
    legs.push({ a, b, path: netPath(a, b, okBoros) });
  }
  const make = (step) => {
    const pts = [{ p: stops[0] }], keep = [0];
    legs.forEach(({ a, b, path }, j) => {
      if (a !== stops[j]) pts.push({ p: a });
      if (path) for (const v of viaPoints(path, step).pts) pts.push(v);
      if (b !== stops[j + 1]) pts.push({ p: b });
      pts.push({ p: stops[j + 1] }); keep.push(pts.length - 1);
    });
    return { pts, keep };
  };
  const offM = (c) => c.offRoute.reduce((s, o) => s + o.meters, 0) + c.parkways.length * 5000;
  let best = null;
  for (const step of [1200, 450]) {
    const { pts, keep } = make(step);
    if (pts.length > 95) break;
    try {
      const rt = await osrm(pts, keep), c = check(rt.geometry.coordinates, stepsAt(rt));
      if (!best || offM(c) < offM(best.compliance)) best = { route: rt, compliance: c };
    } catch {}
    if (best && best.compliance.verdict === "ok") break;
  }
  if (!best) { best = { route: plain, compliance: check(pc, stepsAt(plain)) }; best.compliance.fallback = true; }
  return best;
}

function routes(url, res, send, readBody, req) {
  if (url.pathname === "/api/truck/status") {
    send(res, 200, { status: state.status, error: state.error, asOf: state.asOf, builtAt: state.builtAt, stats: state.stats });
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
  if (url.pathname === "/api/truck/route") {
    const pts = (url.searchParams.get("pts") || "").split(";").map((x) => x.split(",").map(Number)).filter((p) => p.length === 2 && p.every(isFinite));
    if (pts.length < 2 || pts.length > 4) { send(res, 400, { error: "bad points" }); return true; }
    truckRoute(pts).then((r) => send(res, 200, { code: "Ok", routes: [r.route], compliance: { ...r.compliance, asOf: state.asOf } }))
      .catch((e) => send(res, e.code || 502, { error: e.message || "No truck route found" }));
    return true;
  }
  return false;
}

module.exports = { routes, start, check, netPath, state, _build: build };
