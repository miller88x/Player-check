// Phone notifications (store apps) through Firebase Cloud Messaging.
// Free plan: a push when a new ticket shows up on their plate (checked daily).
// Silver / Gold / Fleet: also late-penalty, judgment and boot/tow warnings before they hit.
// Needs FIREBASE_SERVICE_ACCOUNT on Render (the service-account JSON from Firebase, pasted whole or base64).
// Phone tokens and what's been sent live on the account in data._push { tokens:[{t,p,at}], known:{}, sent:{} }.

const crypto = require("crypto");
const auth = require("./auth");
const { findAlerts } = require("./alerts");

const SA = (() => {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")); } catch { console.error("push: FIREBASE_SERVICE_ACCOUNT isn't valid JSON"); return null; }
})();
const ready = () => !!(SA?.client_email && SA?.private_key && SA?.project_id);

// ---------- Supabase ----------
const SB_URL = (process.env.SUPABASE_URL || "").replace(/[\s​-‍﻿ ]/g, "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || "").replace(/[\s​-‍﻿ ]/g, "");
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, ...(SB_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}), "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}
// Write only the _push part, re-reading first so billing or app data saved meanwhile isn't lost
async function savePush(id, mutate) {
  const [u] = await sb(`pc_users?id=eq.${id}&select=data`);
  if (!u) return;
  const data = u.data || {};
  data._push = mutate({ tokens: [], known: {}, sent: {}, ...(data._push || {}) });
  await sb(`pc_users?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ data }), headers: { Prefer: "return=minimal" } });
}

// ---------- Google OAuth token for FCM (signed JWT, no SDK) ----------
let gtoken = null;
async function accessToken() {
  if (gtoken && gtoken.exp > Date.now() + 60000) return gtoken.v;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000), aud = SA.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: SA.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${crypto.createSign("RSA-SHA256").update(unsigned).sign(SA.private_key, "base64url")}`;
  const r = await fetch(aud, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (!r.ok) throw new Error(`google token ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  gtoken = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gtoken.v;
}

// Returns "ok", "gone" (phone uninstalled / token dead) or "error"
async function sendOne(token, title, body, data = {}) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${SA.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title, body }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: "high", notification: { channel_id: "alerts", color: "#8ab4f8" } }, apns: { payload: { aps: { sound: "default" } } } } }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.ok) return "ok";
  const t = await r.text();
  if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*token/i.test(t)) return "gone";
  console.error("push send:", r.status, t.slice(0, 200));
  return "error";
}
async function sendToUser(u, title, body, data) {
  const toks = u.data?._push?.tokens || [];
  const gone = [];
  let sent = 0;
  for (const x of toks) { const r = await sendOne(x.t, title, body, data); if (r === "ok") sent++; if (r === "gone") gone.push(x.t); }
  if (gone.length) await savePush(u.id, (p) => ({ ...p, tokens: p.tokens.filter((x) => !gone.includes(x.t)) }));
  return sent;
}

// ---------- daily run (same trigger as email alerts) ----------
const PAID = ["silver", "gold", "fleet"];
const limitFor = (u) => (u.plan === "fleet" ? Math.max(3, u.data?._billing?.cars || 3) : u.plan === "gold" ? 3 : 1);
const status = { running: false, lastRun: null, lastResult: null };

async function runAll(lookup) {
  if (!ready() || status.running) return;
  status.running = true;
  const result = { users: 0, plates: 0, pushes: 0, errors: 0 };
  try {
    const users = await sb(`pc_users?data->_push->tokens=not.is.null&select=id,email,plan,data`);
    for (const u of users) {
      if (!(u.data?._push?.tokens || []).length) continue;
      result.users++;
      const plates = (u.data.plates || []).filter((x) => x && x.p).slice(0, limitFor(u));
      const paid = PAID.includes(u.plan);
      const known = { ...(u.data._push.known || {}) }, sent = { ...(u.data._push.sent || {}) };
      for (const { p, s = "NY" } of plates) {
        const key = `${p}|${s}`;
        try {
          const data = await lookup(p, s, { locations: false });
          result.plates++;
          if (!known[key]) { // first check for this plate: remember what's there, don't buzz about old tickets
            known[key] = Object.fromEntries(data.tickets.map((t) => [t.summons, t.status]));
            sent[key] = {};
            continue;
          }
          const { items, newKnown, newSent } = findAlerts({ known: known[key], sent: sent[key] || {} }, data);
          known[key] = newKnown; if (paid) sent[key] = newSent; // free plan: warnings aren't sent, so don't mark them (they'll come if the driver upgrades)
          const show = paid ? items : items.filter((i) => i.kind === "new");
          if (!show.length) continue;
          const title = show.length === 1 ? show[0].title : `${show.length} ticket alerts for ${p}`;
          const body = show.length === 1 ? `${p} · ${show[0].detail}` : show.slice(0, 3).map((i) => i.title).join(" · ");
          result.pushes += await sendToUser(u, title, paid || show[0].kind !== "new" ? body : `${body} · Tap to pay or fight it`, { open: "tickets", plate: p, state: s });
        } catch (e) { result.errors++; console.error("push plate:", e.message); }
        await new Promise((r) => setTimeout(r, 400)); // be gentle with NYC Open Data
      }
      await savePush(u.id, (x) => ({ ...x, known, sent }));
    }
  } catch (e) { result.errors++; console.error("push run:", e.message); }
  status.running = false; status.lastRun = new Date().toISOString(); status.lastResult = result;
  console.log("push run:", JSON.stringify(result));
  return result;
}

// ---------- routes ----------
function readJSON(req, max = 4000) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > max) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { reject(e); } }); req.on("error", reject);
  });
}
function routes(url, res, send, req) {
  const p = url.pathname;
  if (!p.startsWith("/api/push/")) return false;
  if (p === "/api/push/status") { send(res, 200, { ready: ready(), lastRun: status.lastRun, lastResult: status.lastResult }); return true; }

  // The store app sends its notification token after the driver allows notifications
  if (p === "/api/push/register" && req.method === "POST") {
    Promise.all([auth.userFromReq(req), readJSON(req)]).then(async ([u, b]) => {
      if (!u) return send(res, 401, { error: "Sign in first." });
      const t = String(b.token || "").trim();
      if (t.length < 20 || t.length > 4096) return send(res, 400, { error: "Bad token" });
      const plat = ["android", "ios"].includes(b.platform) ? b.platform : "other";
      await savePush(u.id, (x) => ({ ...x, tokens: [{ t, p: plat, at: new Date().toISOString() }, ...x.tokens.filter((y) => y.t !== t)].slice(0, 5) }));
      send(res, 200, { ok: true });
    }).catch((e) => { console.error("push register:", e.message); send(res, 500, { error: "Try again." }); });
    return true;
  }
  // "Send me a test notification" from the account screen
  if (p === "/api/push/test" && req.method === "POST") {
    auth.userFromReq(req).then(async (u) => {
      if (!u) return send(res, 401, { error: "Sign in first." });
      if (!ready()) return send(res, 503, { error: "Notifications aren't switched on yet." });
      const n = await sendToUser(u, "Rova notifications are on", "You'll get ticket alerts here before late fees hit.", { open: "home" });
      send(res, n ? 200 : 404, n ? { ok: true, sent: n } : { error: "This phone isn't registered for notifications yet." });
    }).catch((e) => { console.error("push test:", e.message); send(res, 500, { error: "Try again." }); });
    return true;
  }
  send(res, 404, { error: "Not found" });
  return true;
}

module.exports = { routes, runAll, ready, sendOne };
