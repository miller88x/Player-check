// Places every block face's curb colors on the city's own street centerline (dataset inkn-q76z), which uses the
// same street names as the parking sign data. Blocks run from intersection to intersection, so every rule reaches
// its real corner and no block is skipped because a map label is missing. Block sides with no signs on record
// come back too (s: "none"), so nothing on the map is silently blank.

const park = require("./park");

const CL = "https://data.cityofnewyork.us/resource/inkn-q76z.geojson";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
// Only ordinary streets (rw_type 1) have curbside parking: highways, bridges, paths, driveways, ramps etc. are left out
const CURB_TYPES = new Set((process.env.CL_CURB_TYPES || "1").split(","));
const AB = { AVENUE: "AVE", AV: "AVE", STREET: "ST", BOULEVARD: "BLVD", ROAD: "RD", PLACE: "PL", PARKWAY: "PKWY", DRIVE: "DR", LANE: "LN", COURT: "CT", TERRACE: "TER", EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
const nm0 = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => AB[w] || w).join(" ").replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1");
const nm = (v) => nm0(v).replace(/ /g, ""); // "MAC DOUGAL ST" and "MACDOUGAL STREET" are the same street
const tc = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, a, b) => a + b.toLowerCase());
const COMPASS = { EAST: [1, 0], WEST: [-1, 0], NORTH: [0, 1], SOUTH: [0, -1], E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function cityGet(url, ms = 25000) {
  let err;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(url, { headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: AbortSignal.timeout(ms) });
      if (r.ok) return await r.json();
      err = new Error(`city data ${r.status}`);
      if (r.status < 500 && r.status !== 429) throw err;
    } catch (e) { err = e; if (/city data 4/.test(e.message)) throw e; }
    await sleep(700 * (k + 1));
  }
  throw err;
}

// ---------- centerline tiles (same 1,500 ft grid as the signs), cached 7 days ----------
const clCache = new Map(), clBusy = new Map();
async function clTile(tx, ty) {
  const key = `${tx}|${ty}`, hit = clCache.get(key);
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit.segs;
  if (clBusy.has(key)) return clBusy.get(key);
  const p = (async () => {
    const m = 120, x0 = tx * park.TILE - m, x1 = (tx + 1) * park.TILE + m, y0 = ty * park.TILE - m, y1 = (ty + 1) * park.TILE + m;
    const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => { const [la, ln] = park.toLatLng(x, y); return `${ln.toFixed(6)} ${la.toFixed(6)}`; });
    const where = `intersects(the_geom,'POLYGON((${c.join(",")}))')`;
    const j = await cityGet(`${CL}?$select=the_geom,full_street_name,rw_type,number_park_lanes,streetwidth&$where=${encodeURIComponent(where)}&$limit=8000`);
    const segs = [];
    for (const f of j.features || []) {
      const pr = f.properties || {}, g = f.geometry;
      if (!g || !CURB_TYPES.has(String(pr.rw_type))) continue;
      const name = nm(pr.full_street_name); if (!name) continue;
      const lines = g.type === "MultiLineString" ? g.coordinates : g.type === "LineString" ? [g.coordinates] : [];
      for (const L of lines) {
        const pts = L.map(([ln, la]) => park.toStatePlane(la, ln));
        if (pts.length >= 2) segs.push({ name, full: pr.full_street_name, pts, lanes: pr.number_park_lanes == null ? null : +pr.number_park_lanes, w: +pr.streetwidth || null });
      }
    }
    clCache.set(key, { at: Date.now(), segs });
    if (clCache.size > 800) clCache.delete(clCache.keys().next().value);
    return segs;
  })().finally(() => clBusy.delete(key));
  clBusy.set(key, p);
  return p;
}

// ---------- blocks: centerline pieces joined between real intersections ----------
const nodeKey = ([x, y]) => `${Math.round(x / 3)}|${Math.round(y / 3)}`;
function blocks(segs) {
  const seen = new Set(), list = [];
  for (const s of segs) { const k = `${s.name}|${nodeKey(s.pts[0])}|${nodeKey(s.pts[s.pts.length - 1])}|${s.pts.length}`; if (!seen.has(k)) { seen.add(k); list.push(s); } }
  const nodes = new Map();
  list.forEach((s, i) => { for (const end of [0, 1]) { const k = nodeKey(end ? s.pts[s.pts.length - 1] : s.pts[0]); if (!nodes.has(k)) nodes.set(k, []); nodes.get(k).push({ i, end }); } });
  const pass = (k, name) => { const n = nodes.get(k) || []; return n.length === 2 && n.every((e) => list[e.i].name === name); };
  const used = new Set(), out = [];
  list.forEach((s, i) => {
    if (used.has(i)) return;
    used.add(i);
    let pts = s.pts.slice();
    // forward
    for (let k = nodeKey(pts[pts.length - 1]); pass(k, s.name);) {
      const nx = nodes.get(k).find((e) => !used.has(e.i)); if (!nx) break;
      used.add(nx.i); const q = nx.end === 0 ? list[nx.i].pts : list[nx.i].pts.slice().reverse();
      pts = pts.concat(q.slice(1)); k = nodeKey(pts[pts.length - 1]);
    }
    // backward
    for (let k = nodeKey(pts[0]); pass(k, s.name);) {
      const nx = nodes.get(k).find((e) => !used.has(e.i)); if (!nx) break;
      used.add(nx.i); const q = nx.end === 1 ? list[nx.i].pts : list[nx.i].pts.slice().reverse();
      pts = q.slice(0, -1).concat(pts); k = nodeKey(pts[0]);
    }
    const cum = [0]; for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    const crossAt = (p) => [...new Set((nodes.get(nodeKey(p)) || []).map((e) => list[e.i].name).filter((n) => n !== s.name))];
    out.push({ id: out.length, name: s.name, full: s.full, lanes: s.lanes, w: s.w, pts, cum, L: cum[cum.length - 1], crossA: crossAt(pts[0]), crossB: crossAt(pts[pts.length - 1]) });
  });
  return out;
}
// Nearest point on a block: distance along it, distance away, which side (+1 left / -1 right), direction there
function locate(b, [px, py]) {
  let best = null;
  for (let i = 0; i < b.pts.length - 1; i++) {
    const [ax, ay] = b.pts[i], [bx, by] = b.pts[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)), qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
    if (!best || d < best.d) { const l = Math.sqrt(L2); best = { d, s: b.cum[i] + t * l, side: dx * (py - ay) - dy * (px - ax) > 0 ? 1 : -1, ux: dx / l, uy: dy / l }; }
  }
  return best;
}
function slice(b, a, z) {
  const out = [], at = (s) => { let i = 0; while (i < b.cum.length - 2 && b.cum[i + 1] < s) i++; const l = b.cum[i + 1] - b.cum[i] || 1, t = (s - b.cum[i]) / l; return [b.pts[i][0] + (b.pts[i + 1][0] - b.pts[i][0]) * t, b.pts[i][1] + (b.pts[i + 1][1] - b.pts[i][1]) * t]; };
  out.push(at(a)); for (let i = 1; i < b.pts.length - 1; i++) if (b.cum[i] > a && b.cum[i] < z) out.push(b.pts[i]); out.push(at(z));
  return out;
}
const toLL = ([x, y]) => { const [la, ln] = park.toLatLng(x, y); return [+ln.toFixed(6), +la.toFixed(6)]; };
const clsOf = (b) => (b.w >= 70 ? "primary" : b.w >= 45 || /(AVE|BLVD|PKWY|BROADWAY|CONCOURSE)$/.test(b.name) ? "secondary" : "minor");

// rows: sign rows (state plane x,y) for the area; box: [minX,minY,maxX,maxY] of the view (+margin) in feet
async function place(rows, box, now) {
  const [minX, minY, maxX, maxY] = box;
  const jobs = [];
  for (let tx = Math.floor((minX - 300) / park.TILE); tx <= Math.floor((maxX + 300) / park.TILE); tx++)
    for (let ty = Math.floor((minY - 300) / park.TILE); ty <= Math.floor((maxY + 300) / park.TILE); ty++) jobs.push(module.exports.clTile(tx, ty));
  const got = await Promise.allSettled(jobs);
  if (!got.some((g) => g.status === "fulfilled")) throw new Error("street map unavailable");
  const partial = got.some((g) => g.status === "rejected");
  const B = blocks(got.flatMap((g) => (g.status === "fulfilled" ? g.value : [])));
  const byName = new Map(); for (const b of B) { if (!byName.has(b.name)) byName.set(b.name, []); byName.get(b.name).push(b); }

  // Each sign goes to the nearest block of its own street (preferring the block between its cross streets)
  const faces = new Map(), left = []; let ruled = 0;
  for (const r of rows) {
    const rule = park.parseSign(r.sign_description);
    if (!rule) continue;
    ruled++;
    const cands = byName.get(nm(r.on_street)) || [], cross = [nm(r.from_street), nm(r.to_street)];
    let best = null;
    for (const b of cands) {
      const loc = locate(b, [r.x, r.y]); if (!loc || loc.d > 130) continue;
      const hits = cross.filter((c) => b.crossA.includes(c) || b.crossB.includes(c)).length;
      const score = loc.d + (hits ? 0 : 45) + (loc.s < -5 || loc.s > b.L + 5 ? 40 : 0);
      if (!best || score < best.score) best = { b, loc, score };
    }
    if (!best) { left.push(r); continue; }
    const k = `${best.b.id}|${best.loc.side}`;
    if (!faces.has(k)) faces.set(k, { b: best.b, side: best.loc.side, rows: [], signs: [] });
    const v = COMPASS[String(r.arrow_direction || "").toUpperCase()];
    const dir = v ? Math.sign(v[0] * best.loc.ux + v[1] * best.loc.uy) : 0;
    const F = faces.get(k); F.rows.push(r); F.signs.push({ raw: rule.raw, rule, p: Math.max(0, Math.min(best.b.L, best.loc.s)), dir });
  }

  const inView = (b) => b.pts.some(([x, y]) => x > minX && x < maxX && y > minY && y < maxY);
  const feats = [], stats = { blocks: 0, sides: 0, signed: 0, none: 0, partial };
  const emit = (b, side, a, z, props) => {
    let pts = slice(b, a, z), first = a <= 0.5, last = z >= b.L - 0.5;
    if (side > 0) { pts = pts.reverse(); [first, last] = [last, first]; } // curb on the left of the street's direction: flip so it's on the right
    feats.push({ type: "Feature", properties: { ...props, cc: 1, cls: clsOf(b), wft: b.w || undefined, ...(first ? { first: 1 } : {}), ...(last ? { last: 1 } : {}) }, geometry: { type: "LineString", coordinates: pts.map(toLL) } });
  };
  for (const F of faces.values()) {
    if (!inView(F.b)) continue;
    const groups = new Map();
    for (const s of F.signs) { if (!groups.has(s.raw)) groups.set(s.raw, { rule: s.rule, signs: [] }); groups.get(s.raw).signs.push({ p: s.p, dir: s.dir }); }
    // Rules reach the corners: the stretch between the corner and the first (or last) sign follows that sign's rules,
    // never "no rules" (that would paint a corner green)
    const ps = F.signs.map((s) => s.p), lo = Math.min(...ps), hi = Math.max(...ps);
    const zones = park.zoneIntervals(groups, lo, hi).map((z) => ({ ...z, iv: z.iv.map(([a, b]) => [a <= lo + 0.01 ? 0 : a, b >= hi - 0.01 ? F.b.L : b]) }));
    const cuts = [...new Set([0, F.b.L, ...zones.flatMap((z) => z.iv.flat()).filter((p) => p > 0 && p < F.b.L)])].sort((a, b) => a - b);
    const r0 = F.rows[0], props = { st: tc(r0.on_street), fr: tc(r0.from_street), to: tc(r0.to_street), sd: r0.side_of_street || "" };
    let run = null;
    const flush = () => { if (run && run.b - run.a > 3) emit(F.b, F.side, run.a, run.b, { s: run.s, why: run.why, k: run.k || "", ...props }); };
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1], m = (a + b) / 2;
      const st = park.stateNow(zones.filter((z) => z.iv.some(([p0, p1]) => m >= p0 - 1 && m <= p1 + 1)).map((z) => z.rule), now);
      if (run && run.s === st.s && run.why === st.why) run.b = b; else { flush(); run = { a, b, ...st }; }
    }
    flush();
  }
  // Every other block side in view: no parking signs on record (shown gray, never green)
  for (const b of B) {
    if (b.L < 40 || b.lanes === 0 || !inView(b)) continue; // no parking lane on this street: no curb to color
    stats.blocks++;
    for (const side of [-1, 1]) {
      stats.sides++;
      if (faces.has(`${b.id}|${side}`)) { stats.signed++; continue; }
      stats.none++;
      emit(b, side, 0, b.L, { s: "none", why: "No parking signs on record", st: tc(b.full), fr: tc(b.crossA[0] || ""), to: tc(b.crossB[0] || "") });
    }
  }
  stats.placedSigns = ruled - left.length; stats.unplacedSigns = left.length;
  const why = new Map(); for (const r of left) { const k = `${r.on_street} (${byName.has(nm(r.on_street)) ? "too far from its street" : "street name not on the city map"})`; why.set(k, (why.get(k) || 0) + 1); }
  stats.unplacedTop = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${n}× ${k}`);
  return { feats, left, stats };
}

module.exports = { place, blocks, locate, nm, clTile };
