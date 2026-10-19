// Rovers: other Rova drivers on the map, like Waze's "Wazers".
// Real drivers only. Anonymous (random device id, no name, no plate), position rounded to ~10 m,
// shown only while moving, gone 2 minutes after the last update, and never stored or logged.
const rovers = new Map(); // id -> { lat, lng, heading, mph, joined, at }
const rate = new Map();
const STALE = 2 * 60 * 1000;
const okId = (v) => typeof v === "string" && /^[a-z0-9]{12,24}$/.test(v);
// Only known looks are accepted (no free text, so nothing offensive can show up on the map)
const LOOK = { c: ["blue", "red", "green", "purple", "orange", "pink", "teal", "gold", "midnight"], f: ["smile", "grin", "cool", "wink", "sleepy", "wow"], h: ["none", "cap", "beanie", "phones", "crown", "halo"] };
const cleanLook = (l) => (l && typeof l === "object" ? Object.fromEntries(Object.keys(LOOK).map((k) => [k, LOOK[k].includes(l[k]) ? l[k] : LOOK[k][0]])) : null);
const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : null);

function sweep() { const t = Date.now(); for (const [k, r] of rovers) if (t - r.at > STALE) rovers.delete(k); }
setInterval(sweep, 30000).unref();

function routes(url, res, send, readBody, req) {
  if (url.pathname === "/api/rovers/ping" && req.method === "POST") {
    // Carriers put many phones behind one IP, so limit per device (one update per 5 s) plus a loose per-IP cap
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
    const w = rate.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - w.t > 60000) { w.n = 0; w.t = Date.now(); }
    if (++w.n > 600) { send(res, 429, { error: "slow down" }); return true; }
    rate.set(ip, w); if (rate.size > 50000) rate.clear();
    readBody(req).then((b) => {
      if (!okId(b.id)) return send(res, 400, { error: "bad id" });
      const prev = rovers.get(b.id);
      if (!b.off && prev && Date.now() - prev.at < 5000) return send(res, 429, { error: "slow down" });
      if (b.off) { rovers.delete(b.id); return send(res, 200, { ok: true }); }
      const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180), mph = num(b.mph, 0, 200);
      if (lat == null || lng == null) return send(res, 400, { error: "bad position" });
      if (rovers.size > 100000 && !rovers.has(b.id)) return send(res, 503, { error: "busy" });
      rovers.set(b.id, {
        lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4,
        heading: num(b.heading, 0, 360), mph: mph == null ? null : Math.round(mph / 5) * 5,
        joined: num(b.joined, 1.6e12, Date.now() + 864e5), look: cleanLook(b.look), at: Date.now(),
      });
      send(res, 200, { ok: true });
    }).catch(() => send(res, 400, { error: "bad body" }));
    return true;
  }
  if (url.pathname === "/api/rovers") {
    const [w, s, e, n] = ["w", "s", "e", "n"].map((k) => +url.searchParams.get(k));
    if (![w, s, e, n].every(isFinite) || e - w > 0.6 || n - s > 0.6) { send(res, 400, { error: "zoom in" }); return true; }
    const me = url.searchParams.get("me"), t = Date.now(), out = [];
    for (const [k, r] of rovers) {
      if (k === me || t - r.at > STALE) continue;
      if (r.lat < s || r.lat > n || r.lng < w || r.lng > e) continue;
      out.push({ k: k.slice(0, 6), lat: r.lat, lng: r.lng, heading: r.heading, mph: r.mph, joined: r.joined, look: r.look });
      if (out.length >= 80) break;
    }
    send(res, 200, { rovers: out });
    return true;
  }
  return false;
}

module.exports = { routes };
