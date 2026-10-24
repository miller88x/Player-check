// Live traffic colors on every street (like Google's traffic layer).
// The phone asks Rova for map tiles; Rova fetches them from TomTom with its private key, shares a short cache
// between all users, and stops at a daily cap so the free tier is never exceeded (tiles just go blank until midnight).
const KEY = process.env.TOMTOM_KEY || "";
const CAP = +process.env.TRAFFIC_TILE_CAP || 40000; // TomTom free tier: 50,000 traffic tiles a day
const TTL = 120 * 1000; // traffic changes by the minute: 2-minute cache
const MAX = 2500; // tiles kept in memory (~25-40 MB)
const cache = new Map(); // key -> { buf, t }
let day = "", used = 0;
const EMPTY = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function today() { return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }); }

async function tile(z, x, y, style) {
  const k = `${style}/${z}/${x}/${y}`, hit = cache.get(k);
  if (hit && Date.now() - hit.t < TTL) { cache.delete(k); cache.set(k, hit); return hit.buf; }
  if (day !== today()) { day = today(); used = 0; }
  if (!KEY || used >= CAP) return null;
  used++;
  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png?key=${KEY}&tileSize=256&thickness=${z >= 15 ? 12 : z >= 13 ? 9 : 7}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`TomTom traffic ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  cache.set(k, { buf, t: Date.now() });
  while (cache.size > MAX) cache.delete(cache.keys().next().value);
  return buf;
}

function routes(url, res, send) {
  const m = url.pathname.match(/^\/api\/traffic\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
  if (url.pathname === "/api/traffic/status") { send(res, 200, { on: !!KEY, usedToday: used, cap: CAP, cached: cache.size }); return true; }
  if (!m) return false;
  const [z, x, y] = m.slice(1).map(Number), n = 2 ** z;
  const out = (buf, maxAge) => { res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": `public, max-age=${maxAge}` }); res.end(buf); };
  if (z < 6 || z > 18 || x >= n || y >= n) { out(EMPTY, 3600); return true; }
  const style = url.searchParams.get("s") === "dark" ? "relative0-dark" : "relative0";
  tile(z, x, y, style).then((buf) => out(buf || EMPTY, buf ? 120 : 300)).catch(() => out(EMPTY, 60));
  return true;
}

module.exports = { routes };
