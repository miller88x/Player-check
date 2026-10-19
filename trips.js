// Share your drive, like Waze/Google: the driver's phone posts its position + ETA,
// anyone with the link sees a live map. Trips live in server memory (they last minutes, so a restart is fine).
const trips = new Map(); // id -> { id, key, name, dest, lat, lng, heading, eta, left, updated, ended }
const TTL = 3 * 3600e3;

const clean = () => { const t = Date.now(); for (const [id, x] of trips) if (t - x.updated > TTL) trips.delete(id); };
const rid = (n) => Array.from({ length: n }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]).join("");
const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v, n) => String(v || "").slice(0, n);

function page(id) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Live drive · Rova</title>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<style>html,body{margin:0;height:100%;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#202124}#map{position:fixed;inset:0}
.card{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 12px);max-width:520px;margin:0 auto;background:#fff;color:#202124;border-radius:20px;padding:16px 18px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.eta{font-size:28px;font-weight:800;color:#188038}.sub{color:#5f6368;margin-top:4px;font-size:15px}.brand{font-size:12px;color:#9aa0a6;margin-top:10px}
.car{width:22px;height:22px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 0 0 6px rgba(26,115,232,.25)}</style></head>
<body><div id="map"></div><div class="card"><div class="eta" id="eta">Loading…</div><div class="sub" id="sub"></div><div class="brand">Shared from Rova · updates live</div></div>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
const map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty", center: [-73.95, 40.7], zoom: 12 });
const el = document.createElement("div"); el.className = "car"; let mk = null, first = true;
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function tick() {
  try {
    const r = await fetch("/api/trip/${id}"); const t = await r.json();
    if (!r.ok) { document.getElementById("eta").textContent = "This drive has ended"; document.getElementById("sub").textContent = ""; return; }
    const name = esc(t.name || "Your friend");
    if (t.ended) { document.getElementById("eta").textContent = t.arrived ? name + " has arrived" : "Drive ended"; document.getElementById("sub").textContent = esc(t.dest); }
    else {
      const at = new Date(Date.now() + t.eta * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      document.getElementById("eta").textContent = "Arriving " + at;
      document.getElementById("sub").innerHTML = name + " is driving to " + esc(t.dest) + " · " + Math.max(1, Math.round(t.eta / 60)) + " min · " + (t.left / 1609).toFixed(1) + " mi left";
    }
    if (t.lat != null) {
      if (!mk) mk = new maplibregl.Marker({ element: el }).setLngLat([t.lng, t.lat]).addTo(map); else mk.setLngLat([t.lng, t.lat]);
      if (first) { map.jumpTo({ center: [t.lng, t.lat], zoom: 14 }); first = false; } else map.easeTo({ center: [t.lng, t.lat], duration: 900 });
    }
    if (!t.ended) setTimeout(tick, 8000);
  } catch { setTimeout(tick, 15000); }
}
map.on("load", tick);
</script></body></html>`;
}

function routes(url, res, send, readBody, req) {
  clean();
  // Start a shared drive
  if (url.pathname === "/api/trip" && req.method === "POST") {
    readBody(req).then((b) => {
      if (trips.size > 5000) return send(res, 503, { error: "busy" });
      // The phone may pick its own id/key so it can open the share sheet right from the tap (iPhone needs that)
      const okId = typeof b.id === "string" && /^[a-z0-9]{8}$/.test(b.id) && !trips.has(b.id) && typeof b.key === "string" && /^[a-z0-9]{16}$/.test(b.key);
      const id = okId ? b.id : rid(8), key = okId ? b.key : rid(16);
      trips.set(id, { id, key, name: str(b.name, 40), dest: str(b.dest, 80), lat: num(b.lat, -90, 90), lng: num(b.lng, -180, 180), eta: num(b.eta, 0, 864e2) || 0, left: num(b.left, 0, 5e6) || 0, updated: Date.now(), ended: false });
      send(res, 200, { id, key });
    }).catch(() => send(res, 400, { error: "bad body" }));
    return true;
  }
  const m = url.pathname.match(/^\/api\/trip\/([a-z0-9]{8})$/);
  if (m) {
    const t = trips.get(m[1]);
    if (req.method === "POST") {
      readBody(req).then((b) => {
        if (!t || b.key !== t.key) return send(res, 403, { error: "not yours" });
        const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
        if (lat != null && lng != null) Object.assign(t, { lat, lng });
        if (num(b.eta, 0, 864e2) != null) t.eta = b.eta;
        if (num(b.left, 0, 5e6) != null) t.left = b.left;
        if (b.ended) { t.ended = true; t.arrived = !!b.arrived; }
        t.updated = Date.now();
        send(res, 200, { ok: true });
      }).catch(() => send(res, 400, { error: "bad body" }));
      return true;
    }
    if (!t) { send(res, 404, { error: "ended" }); return true; }
    const { key, ...pub } = t;
    send(res, 200, pub);
    return true;
  }
  return false;
}

module.exports = { routes, page };
