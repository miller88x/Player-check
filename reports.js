// Driver reports, Waze-style: police, accidents, hazards… plus NYC-only ones
// (ticket agent on the block, tow truck, street sweeper already passed).
// Saved in Supabase when it's set up (table pc_road_reports); otherwise kept in memory on the server.

const SB_URL = (process.env.SUPABASE_URL || "").replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, "").replace(/\/+$/, "");
// Keys never contain spaces, line breaks or invisible characters — strip any picked up while copying on a phone
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || "").replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, "");
const useDb = () => !!(SB_URL && SB_KEY);

// type -> how long a report stays on the map (minutes)
const TYPES = {
  police: 60, agent: 45, tow: 30, sweeper: 180, accident: 90, hazard: 120,
  traffic: 45, construction: 720, closed: 360, pothole: 10080, camera: 10080, spot: 15,
};

let mem = []; // fallback store
const rate = new Map();

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, ...(SB_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}), "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const meters = (a, b) => Math.hypot((a.lng - b.lng) * 84300, (a.lat - b.lat) * 111200);

async function list(b) {
  if (useDb()) {
    return sb(`pc_road_reports?select=id,type,lat,lng,note,created_at,expires_at,up,down&expires_at=gt.${iso(now())}` +
      `&lng=gte.${b[0]}&lat=gte.${b[1]}&lng=lte.${b[2]}&lat=lte.${b[3]}&order=created_at.desc&limit=400`);
  }
  mem = mem.filter((r) => new Date(r.expires_at) > now());
  return mem.filter((r) => r.lng >= b[0] && r.lat >= b[1] && r.lng <= b[2] && r.lat <= b[3]).slice(0, 400);
}

async function add({ type, lat, lng, note }) {
  // Same thing reported close by in the last 15 min → confirm it instead of stacking pins
  const near = (await list([lng - 0.002, lat - 0.002, lng + 0.002, lat + 0.002]))
    .find((r) => r.type === type && meters(r, { lat, lng }) < 120 && now() - new Date(r.created_at) < 15 * 60000);
  if (near) return vote(near.id, true);
  const row = { type, lat, lng, note: note || null, created_at: iso(now()), expires_at: iso(now() + TYPES[type] * 60000), up: 1, down: 0 };
  if (useDb()) return (await sb("pc_road_reports", { method: "POST", body: JSON.stringify(row) }))[0];
  row.id = `${now()}${Math.random().toString(36).slice(2, 7)}`;
  mem.unshift(row); mem = mem.slice(0, 5000);
  return row;
}

async function vote(id, up) {
  const get = async () => (useDb() ? (await sb(`pc_road_reports?id=eq.${encodeURIComponent(id)}&select=*`))[0] : mem.find((r) => String(r.id) === String(id)));
  const r = await get();
  if (!r) throw new Error("That report is gone.");
  const patch = up
    ? { up: r.up + 1, expires_at: iso(Math.max(new Date(r.expires_at).getTime(), now() + Math.min(TYPES[r.type], 60) * 60000)) } // "still there" keeps it alive
    : { down: r.down + 1, ...(r.down + 1 >= 2 && r.down + 1 >= r.up ? { expires_at: iso(now()) } : {}) };       // two "not there" votes remove it
  if (useDb()) return (await sb(`pc_road_reports?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }))[0];
  Object.assign(r, patch); return r;
}

function limited(ip, max = 12) { // 12 reports/votes per 10 minutes per visitor
  const k = `${ip}|${Math.floor(now() / 600000)}`, n = (rate.get(k) || 0) + 1;
  rate.set(k, n); if (rate.size > 20000) rate.clear();
  return n > max;
}

function routes(url, res, sendJSON, readBody, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  if (url.pathname === "/api/reports/health") {
    const info = { db: useDb(), urlSet: !!SB_URL, urlHost: SB_URL.replace(/^https?:\/\//, ""), keyType: SB_KEY.startsWith("sb_secret_") ? "secret" : SB_KEY.startsWith("eyJ") ? "jwt" : SB_KEY ? "other" : "none",
      keyLength: SB_KEY.length, badChars: [...SB_KEY].filter((c) => !/[A-Za-z0-9_.\-]/.test(c)).map((c) => c.charCodeAt(0)) };
    (useDb() ? sb("pc_road_reports?select=id&limit=1").then((r) => ({ ok: true, rows: r.length })) : Promise.resolve({ ok: true, memory: true }))
      .then((r) => sendJSON(res, 200, { ...info, ...r }))
      .catch((e) => sendJSON(res, 200, { ...info, ok: false, error: String(e.message).replace(SB_KEY, "[key]") }));
    return true;
  }
  if (url.pathname === "/api/reports" && req.method === "GET") {
    const b = (url.searchParams.get("bbox") || "").split(",").map(Number);
    if (b.length !== 4 || b.some(isNaN) || b[2] - b[0] > 0.6 || b[3] - b[1] > 0.6) { sendJSON(res, 200, { reports: [] }); return true; }
    list(b).then((r) => sendJSON(res, 200, { reports: r, saved: useDb() })).catch((e) => { console.error(e.message); sendJSON(res, 200, { reports: [] }); });
    return true;
  }
  if (url.pathname === "/api/reports" && req.method === "POST") {
    readBody(req).then(async (b) => {
      if (limited(ip)) return sendJSON(res, 429, { error: "Too many reports. Try again in a few minutes." });
      const type = String(b.type || ""), lat = +b.lat, lng = +b.lng;
      if (!TYPES[type] || !(lat > 40.3 && lat < 41.3) || !(lng > -74.6 && lng < -73.3)) return sendJSON(res, 400, { error: "Reports work inside the NYC area." });
      try { sendJSON(res, 200, { report: await add({ type, lat, lng, note: String(b.note || "").slice(0, 80) }) }); }
      catch (e) { console.error(e.message); sendJSON(res, 500, { error: "Couldn't save the report. Try again." }); }
    }).catch(() => sendJSON(res, 400, { error: "Bad request" }));
    return true;
  }
  if (url.pathname === "/api/reports/vote" && req.method === "POST") {
    readBody(req).then(async (b) => {
      if (limited(ip, 30)) return sendJSON(res, 429, { error: "Slow down a little." });
      try { sendJSON(res, 200, { report: await vote(String(b.id || ""), !!b.up) }); }
      catch (e) { sendJSON(res, 404, { error: e.message }); }
    }).catch(() => sendJSON(res, 400, { error: "Bad request" }));
    return true;
  }
  return false;
}

module.exports = { routes, TYPES };
