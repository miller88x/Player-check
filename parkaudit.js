// City-wide parking accuracy audit. Uses the city's own signs as the answer key:
// right next to every sign pole, the rules in force should be exactly the rules that pole posts for that direction.
//  - "extra"  = Rova applies a rule the pole doesn't post (false red, like Caton Ave)
//  - "missing" = the pole posts a rule Rova doesn't apply (false green, a ticket risk)
// Compares the old arrow logic, the first Caton fix and the live logic. Results go to the server log (PARKAUDIT).
// Runs when PARK_AUDIT=1 is set on Render (once, after start-up) or via /api/park/audit?key=ALERTS_KEY.

const park = require("./park");

const AREAS = [
  ["Kensington (Caton Ave)", 40.6495, -73.9681], ["Bed-Stuy", 40.6868, -73.9330], ["East New York", 40.6705, -73.8935], ["Park Slope", 40.6720, -73.9790],
  ["Williamsburg", 40.7140, -73.9570], ["Flatbush", 40.6400, -73.9590], ["Bay Ridge", 40.6290, -74.0250], ["Downtown Brooklyn", 40.6920, -73.9870],
  ["Sunset Park", 40.6450, -74.0100], ["Borough Park", 40.6330, -73.9930], ["Crown Heights", 40.6690, -73.9440], ["Bensonhurst", 40.6040, -73.9960],
  ["Sheepshead Bay", 40.5870, -73.9540], ["Greenpoint", 40.7290, -73.9540], ["Bushwick", 40.6950, -73.9180], ["Canarsie", 40.6400, -73.9030],
  ["Midtown", 40.7540, -73.9840], ["Upper West Side", 40.7870, -73.9750], ["Upper East Side", 40.7730, -73.9560], ["Harlem", 40.8110, -73.9460],
  ["Lower East Side", 40.7150, -73.9850], ["Chelsea", 40.7450, -74.0010], ["Washington Heights", 40.8460, -73.9380], ["Financial District", 40.7070, -74.0090],
  ["Astoria", 40.7640, -73.9230], ["Jackson Heights", 40.7500, -73.8830], ["Flushing", 40.7590, -73.8300], ["Jamaica", 40.7020, -73.7990],
  ["Long Island City", 40.7450, -73.9480], ["Forest Hills", 40.7190, -73.8450], ["Ridgewood", 40.7050, -73.9050], ["Bayside", 40.7630, -73.7700],
  ["Mott Haven", 40.8090, -73.9230], ["Fordham", 40.8610, -73.8900], ["Parkchester", 40.8370, -73.8600], ["Riverdale", 40.8890, -73.9080],
  ["St. George", 40.6430, -74.0770], ["New Dorp", 40.5730, -74.1170], ["Port Richmond", 40.6330, -74.1350],
];

const COMPASS = { EAST: [1, 0], WEST: [-1, 0], NORTH: [0, 1], SOUTH: [0, -1], E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };
const AB = { AVENUE: "AVE", AV: "AVE", STREET: "ST", BOULEVARD: "BLVD", ROAD: "RD", PLACE: "PL", PARKWAY: "PKWY", DRIVE: "DR", LANE: "LN", COURT: "CT", TERRACE: "TER", EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
const nm = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => AB[w] || w).join(" ").replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1");

// Zones under a given arrow rule. opt.other: a zone ends where a different rule starts the same way (current logic).
// opt.both: ...also where a different rule's two-way sign stands without this rule on the pole.
function zones(signs, lo, hi, opt) {
  const out = [];
  const byRaw = new Map();
  for (const s of signs) { if (!byRaw.has(s.raw)) byRaw.set(s.raw, []); byRaw.get(s.raw).push(s); }
  const stops = (raw, dir, from) => !opt.other ? [] : signs.filter((o) => o.raw !== raw && (o.dir === dir || (opt.both && o.dir === 0)) && (dir > 0 ? o.p > from + 5 : o.p < from - 5)
    && !signs.some((x) => x.raw === raw && (x.dir === dir || x.dir === 0) && Math.abs(x.p - o.p) <= 5)).map((o) => o.p);
  for (const [raw, list] of byRaw) {
    const iv = list.map((g) => {
      const back = (side) => list.filter((o) => (side > 0 ? o.p > g.p + 5 && o.dir === -1 : o.p < g.p - 5 && o.dir === 1)).map((o) => o.p);
      const L = back(-1), R = back(1);
      if (g.dir === 1) return [g.p, Math.min(hi, ...R, ...stops(raw, 1, g.p))];
      if (g.dir === -1) return [Math.max(lo, ...L, ...stops(raw, -1, g.p)), g.p];
      return [L.length ? Math.max(...L) : lo, R.length ? Math.min(...R) : hi];
    });
    out.push({ raw, rule: list[0].rule, iv });
  }
  return out;
}

const toGroups = (signs) => { const g = new Map(); for (const s of signs) { if (!g.has(s.raw)) g.set(s.raw, { rule: s.rule, signs: [] }); g.get(s.raw).signs.push({ p: s.p, dir: s.dir }); } return g; };
const VARIANTS = {
  old: (signs, lo, hi) => park.zoneIntervals(toGroups(signs), lo, hi, { dom: false }),
  first: (signs, lo, hi) => zones(signs, lo, hi, { other: true }), // this morning's Caton fix
  now: (signs, lo, hi) => park.zoneIntervals(toGroups(signs), lo, hi), // proof-based ending (live)
};
const short = (raw) => String(raw).replace(/\s*\(SUPERSEDES[^)]*\)/g, "").replace(/\s+/g, " ").slice(0, 60);

async function facesNear(lat, lng, d) {
  const [x0, y0] = park.toStatePlane(lat - d * 0.75, lng - d), [x1, y1] = park.toStatePlane(lat + d * 0.75, lng + d);
  const rows = [];
  for (let tx = Math.floor(Math.min(x0, x1) / park.TILE); tx <= Math.floor(Math.max(x0, x1) / park.TILE); tx++)
    for (let ty = Math.floor(Math.min(y0, y1) / park.TILE); ty <= Math.floor(Math.max(y0, y1) / park.TILE); ty++) rows.push(...(await park.tileRows(tx, ty)));
  const seen = new Set(), faces = new Map();
  for (const r of rows) {
    if (r.x < Math.min(x0, x1) || r.x > Math.max(x0, x1) || r.y < Math.min(y0, y1) || r.y > Math.max(y0, y1)) continue;
    const k = `${r.on_street}|${r.side_of_street}|${r.from_street}|${r.to_street}|${r.x}|${r.y}|${r.sign_description}|${r.arrow_direction}`;
    if (seen.has(k)) continue; seen.add(k);
    const f = `${nm(r.on_street)}|${r.side_of_street}|${[nm(r.from_street), nm(r.to_street)].sort().join("~")}`;
    if (!faces.has(f)) faces.set(f, []);
    faces.get(f).push(r);
  }
  return [...faces.values()];
}

async function audit() {
  const t0 = Date.now(), now = park.nyNow(new Date());
  const tot = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, { checks: 0, extra: 0, missing: 0, wrong: 0, redFt: 0 }]));
  const examples = { extra: new Map(), missing: new Map() }, per = [];
  const cov = {}, covPer = [], unplaced = [];
  let faces = 0, poles = 0, signsN = 0, skipped = 0;
  for (const [name, lat, lng] of AREAS) {
    const a = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, { checks: 0, extra: 0, missing: 0, wrong: 0 }]));
    try {
      for (const face of await facesNear(lat, lng, 0.004)) {
        let ux = 1, uy = 0, best = 0;
        for (const p of face) for (const q of face) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d > best) { best = d; ux = (q.x - p.x) / d; uy = (q.y - p.y) / d; } }
        if (best < 60 || best > 2000) { skipped++; continue; } // one pole / two blocks: nothing to check along it
        const signs = [];
        for (const s of face) {
          const rule = park.parseSign(s.sign_description); if (!rule) continue;
          const v = COMPASS[String(s.arrow_direction || "").toUpperCase()];
          signs.push({ raw: rule.raw, rule, p: s.x * ux + s.y * uy, dir: v ? Math.sign(v[0] * ux + v[1] * uy) : 0 });
        }
        if (!signs.length) continue;
        faces++; signsN += signs.length;
        const ps = signs.map((s) => s.p), lo = Math.min(...ps) - 40, hi = Math.max(...ps) + 40;
        // poles: signs within 5 ft of each other
        const pl = [];
        for (const s of [...signs].sort((m, n) => m.p - n.p)) { const last = pl[pl.length - 1]; if (last && s.p - last.p <= 5) last.signs.push(s); else pl.push({ p: s.p, signs: [s] }); }
        poles += pl.length;
        const zs = Object.fromEntries(Object.entries(VARIANTS).map(([v, f]) => [v, f(signs, lo, hi)]));
        pl.forEach((pole, i) => {
          for (const d of [1, -1]) {
            const nb = pl[i + d];
            if (!nb) continue; // past the last pole the rule runs to the corner: nothing on the street to compare with
            const probe = pole.p + d * Math.min(12, Math.abs(nb.p - pole.p) / 2);
            const want = new Set(pole.signs.filter((s) => s.dir === d || s.dir === 0).map((s) => s.raw));
            if (!want.size) continue; // pole only ends rules on this side: no claim about what starts
            for (const v of Object.keys(VARIANTS)) {
              const have = new Set(zs[v].filter((z) => z.iv.some(([m, n]) => probe >= m && probe <= n)).map((z) => z.raw));
              const extra = [...have].filter((r) => !want.has(r)), missing = [...want].filter((r) => !have.has(r));
              a[v].checks++; tot[v].checks++;
              if (extra.length) { a[v].extra++; tot[v].extra++; }
              if (missing.length) { a[v].missing++; tot[v].missing++; }
              // proven wrong: Rova applies a rule that would make one of this pole's own signs pointless
              const rr = (raw) => signs.find((s) => s.raw === raw).rule;
              if (extra.some((x) => pole.signs.some((s) => park.dominates(rr(x), s.rule)))) { a[v].wrong++; tot[v].wrong++; }
              if (v === "now") for (const [kind, list] of [["extra", extra], ["missing", missing]]) for (const r of list) {
                const key = `${short(r)}`;
                const e = examples[kind].get(key) || { n: 0, at: `${face[0].on_street} ${face[0].side_of_street} side, ${face[0].from_street}→${face[0].to_street} (${name})`, pole: pole.signs.map((s) => `${short(s.raw).slice(0, 28)}${s.dir > 0 ? "→" : s.dir < 0 ? "←" : "↔"}`).join(" + ") };
                e.n++; examples[kind].set(key, e);
              }
            }
          }
        });
        // red footage right now along the face, per variant
        for (const v of Object.keys(VARIANTS)) for (let p = lo; p < hi; p += 10) {
          const rules = zs[v].filter((z) => z.iv.some(([m, n]) => p >= m && p <= n)).map((z) => z.rule);
          if (rules.length && park.stateNow(rules, now).s === "red") tot[v].redFt += 10;
        }
      }
      // Coverage: how many block sides in a phone-screen view come back colored, gray (no signs) or not at all
      try {
        const dv = 0.0025, fc = await park.curbs(lng - dv, lat - dv * 0.75, lng + dv, lat + dv * 0.75), st = fc.stats || {};
        const backup = fc.features.filter((f) => f.geometry.type === "LineString" && !f.properties.cc).length;
        for (const e of st.grayEx || []) unplaced.push(`${name}: GRAY BUT SIGNS NEARBY: ${e}`);
        for (const k of ["blocks", "sides", "signed", "none", "placedSigns", "unplacedSigns", "grayWithSigns"]) cov[k] = (cov[k] || 0) + (st[k] || 0);
        cov.backup = (cov.backup || 0) + backup; if (!fc.stats) cov.noMap = (cov.noMap || 0) + 1;
        for (const u of st.unplacedTop || []) unplaced.push(`${name}: ${u}`);
        covPer.push(`${name}: ${st.sides || 0} block sides · ${st.signed || 0} with signs · ${st.none || 0} no signs (gray) · gray with signs nearby ${st.grayWithSigns || 0} · signs placed ${st.placedSigns || 0}, not placed ${st.unplacedSigns || 0}${fc.stats ? "" : " · CITY STREET MAP FAILED"}`);
      } catch (e) { covPer.push(`${name}: coverage ERROR ${e.message}`); }
      const pc = (v) => (a[v].checks ? `${(100 * (1 - (a[v].extra + a[v].missing) / a[v].checks)).toFixed(1)}%` : "-");
      per.push(`${name}: ${a.now.checks} checks · agree old ${pc("old")} → first fix ${pc("first")} → now ${pc("now")} · proven wrong old ${a.old.wrong} → now ${a.now.wrong}`);
    } catch (e) { per.push(`${name}: ERROR ${e.message}`); }
  }
  const sum = Object.fromEntries(Object.entries(tot).map(([v, t]) => [v, { ...t, agree: `${(100 * (1 - (t.extra + t.missing) / Math.max(1, t.checks))).toFixed(2)}%` }]));
  console.log("PARKAUDIT summary " + JSON.stringify({ areas: AREAS.length, faces, poles, signs: signsN, skippedOnePole: skipped, secs: Math.round((Date.now() - t0) / 1000), ...sum }));
  for (const l of per) console.log("PARKAUDIT area " + l);
  console.log("PARKAUDIT coverage " + JSON.stringify(cov));
  for (const l of covPer) console.log("PARKAUDIT cov " + l);
  for (const l of unplaced.slice(0, 90)) console.log("PARKAUDIT unplaced " + l);
  for (const kind of ["extra", "missing"]) for (const [k, e] of [...examples[kind].entries()].sort((m, n) => n[1].n - m[1].n).slice(0, 25))
    console.log(`PARKAUDIT ${kind} ${e.n}× ${k} | e.g. ${e.at} | pole: ${e.pole}`);
  return sum;
}

let running = false;
function run() { if (running) return; running = true; audit().catch((e) => console.error("PARKAUDIT failed", e.message)).finally(() => (running = false)); }
module.exports = { audit, run, zones, VARIANTS };
