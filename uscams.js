// Speed and red light cameras outside NYC, from OpenStreetMap (free, crowd-mapped).
// Fetched per map area on demand and cached on the server, in 0.5° tiles (~35 miles).
// NYC keeps its own, more complete list built from city ticket data (cameras.js).

const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const TILE = 0.5;
const cache = new Map(); // "lat|lng" -> { at, cams }
const inflight = new Map();
const DAY = 864e5;
const NYC = { s: 40.47, w: -74.27, n: 40.93, e: -73.68 };

const inNYC = (lat, lng) => lat > NYC.s && lat < NYC.n && lng > NYC.w && lng < NYC.e;

function parse(osm) {
  const nodes = new Map(), cams = [];
  for (const el of osm.elements || []) if (el.type === "node") nodes.set(el.id, el);
  const seen = new Set();
  const push = (lat, lng, type, tags = {}) => {
    if (lat == null || lng == null || inNYC(lat, lng)) return;
    const k = `${lat.toFixed(5)},${lng.toFixed(5)}`; if (seen.has(k)) return; seen.add(k);
    const dir = /^\d+$/.test(tags.direction || "") ? +tags.direction : null;
    const limit = parseInt(tags.maxspeed, 10) || null; // OSM US values are usually "35 mph"
    cams.push({ type, lat: +lat.toFixed(6), lng: +lng.toFixed(6), heading: dir, limit, name: tags.name || "", n: 0, src: "osm" });
  };
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    if (el.type === "node" && t.highway === "speed_camera") push(el.lat, el.lon, "speed", t);
    if (el.type === "node" && /traffic_signals|red_light/.test(t.enforcement || "")) push(el.lat, el.lon, "redlight", t);
    if (el.type === "relation" && t.type === "enforcement") {
      const type = /traffic_signals/.test(t.enforcement || "") ? "redlight" : /maxspeed|average_speed/.test(t.enforcement || "") ? "speed" : null;
      if (!type) continue;
      const dev = (el.members || []).find((m) => m.type === "node" && m.role === "device") || (el.members || []).find((m) => m.type === "node");
      const nd = dev && nodes.get(dev.ref);
      if (nd) push(nd.lat, nd.lon, type, { ...nd.tags, ...t });
    }
  }
  return cams;
}

async function fetchTile(lat0, lng0) {
  const s = lat0, w = lng0, n = lat0 + TILE, e = lng0 + TILE;
  const q = `[out:json][timeout:25];(node["highway"="speed_camera"](${s},${w},${n},${e});node["enforcement"~"traffic_signals|red_light"](${s},${w},${n},${e});relation["type"="enforcement"]["enforcement"~"maxspeed|traffic_signals|average_speed"](${s},${w},${n},${e}););out body;>;out skel qt;`;
  let lastErr;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "PlateCheck/1.0" }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      return parse(await res.json());
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function tile(lat0, lng0) {
  const k = `${lat0}|${lng0}`, hit = cache.get(k);
  if (hit && Date.now() - hit.at < 7 * DAY) return hit.cams;
  if (inflight.has(k)) return inflight.get(k);
  const p = fetchTile(lat0, lng0)
    .then((cams) => { cache.set(k, { at: Date.now(), cams }); if (cache.size > 3000) cache.delete(cache.keys().next().value); return cams; })
    .catch(() => (hit ? hit.cams : []))
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function area(s, w, n, e) {
  const tiles = [];
  for (let la = Math.floor(s / TILE) * TILE; la < n; la += TILE)
    for (let ln = Math.floor(w / TILE) * TILE; ln < e; ln += TILE) tiles.push([+la.toFixed(2), +ln.toFixed(2)]);
  if (tiles.length > 6) return []; // zoomed out too far
  const all = await Promise.all(tiles.map(([a, b]) => tile(a, b)));
  return all.flat();
}

function routes(url, res, sendJSON) {
  if (url.pathname !== "/api/cameras/area") return false;
  const b = (url.searchParams.get("bbox") || "").split(",").map(Number);
  if (b.length !== 4 || b.some(isNaN)) { sendJSON(res, 400, { error: "bbox=w,s,e,n" }); return true; }
  const [w, s, e, n] = b;
  area(s, w, n, e).then((cams) => sendJSON(res, 200, { cameras: cams })).catch(() => sendJSON(res, 200, { cameras: [] }));
  return true;
}

module.exports = { routes, parse, inNYC };
