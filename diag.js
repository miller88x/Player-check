// One-off look at the city's street centerline data (field names, road types) so curbs can be placed on it. Logs PARKDIAG.
const park = require("./park");
async function run() {
  try {
    const pts = [["Richmond Hill", 40.6905, -73.8410], ["NYU", 40.7295, -73.9955]];
    for (const [name, lat, lng] of pts) {
      const d = 0.003, poly = `POLYGON((${lng - d} ${lat - d},${lng + d} ${lat - d},${lng + d} ${lat + d},${lng - d} ${lat + d},${lng - d} ${lat - d}))`;
      const u = `https://data.cityofnewyork.us/resource/inkn-q76z.geojson?$where=${encodeURIComponent(`intersects(the_geom,'${poly}')`)}&$limit=2000`;
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); const t = await r.text();
      if (!r.ok) { console.log("PARKDIAG", name, "HTTP", r.status, t.slice(0, 300)); continue; }
      const j = JSON.parse(t), f = j.features || [];
      console.log("PARKDIAG", name, "segments", f.length, "fields", Object.keys(f[0]?.properties || {}).join(","));
      const by = {}; for (const x of f) { const k = x.properties.rw_type; (by[k] ||= { n: 0, ex: new Set() }).n++; if (by[k].ex.size < 6) by[k].ex.add(x.properties.full_street_name); }
      for (const [k, v] of Object.entries(by)) console.log("PARKDIAG", name, "rw_type", k, v.n, [...v.ex].join(" | "));
      const s = f.find((x) => /105|WASHINGTON P/.test(x.properties.full_street_name || ""));
      if (s) console.log("PARKDIAG", name, "sample", JSON.stringify(s.properties).slice(0, 900), JSON.stringify(s.geometry).slice(0, 200));
    }
  } catch (e) { console.log("PARKDIAG failed", e.message); }
}
module.exports = { run };
