// Accounts: email + password sign-in, so plates, tickets, parked car and plan follow the driver to any phone.
// Stored in Supabase tables pc_users and pc_sessions (RLS on, no policies — only this server's secret key can reach them).
// Passwords are hashed with scrypt; the phone only ever holds a random session token (the server stores its SHA-256 hash).

const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/[\s​-‍﻿ ]/g, "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || "").replace(/[\s​-‍﻿ ]/g, "");
const ready = () => !!(SB_URL && SB_KEY);
const PLANS = ["free", "bronze", "silver", "gold", "fleet"];
// Free Gold for listed accounts (store reviewers, your own testing): COMP_GOLD on Render = comma-separated emails
const COMP = new Set((process.env.COMP_GOLD || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
const TRUCK_ON = new Set(["active", "trialing", "past_due"]);
const isComp = (u) => !!u && COMP.has(String(u.email).toLowerCase());
const comp = (u) => { if (u && COMP.has(String(u.email).toLowerCase()) && (!u.plan || u.plan === "free")) u.plan = "gold"; return u; };
const SESSION_DAYS = 365;
const MAX_DATA = 200000; // ~200 KB of synced app data per account

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, ...(SB_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}), "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const t = await res.text();
  if (!res.ok) { const e = new Error(`Supabase ${res.status}: ${t.slice(0, 160)}`); e.status = res.status; e.body = t; throw e; }
  return t ? JSON.parse(t) : null;
}

// ---------- passwords + tokens ----------
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k))));
async function hashPw(pw) { const salt = crypto.randomBytes(16); return `s1$${salt.toString("hex")}$${(await scrypt(pw, salt)).toString("hex")}`; }
async function checkPw(pw, stored) {
  const [v, salt, hash] = String(stored || "").split("$");
  if (v !== "s1" || !salt || !hash) return false;
  const k = await scrypt(pw, Buffer.from(salt, "hex"));
  return crypto.timingSafeEqual(k, Buffer.from(hash, "hex"));
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cleanEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 120);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await sb("pc_sessions", { method: "POST", body: JSON.stringify({ token_hash: sha(token), user_id: userId, expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() }), headers: { Prefer: "return=minimal" } });
  return token;
}
// _billing is server-owned (set by the Stripe webhook): the phone gets a short summary, never the raw ids
const pub = (u) => {
  comp(u);
  const all = u.data || {}, b = all._billing;
  const data = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("_"))); // _billing, _push: server-owned
  return { email: u.email, plan: PLANS.includes(u.plan) ? u.plan : "free", data, since: u.created_at,
    billing: b ? { status: b.status || null, ends: b.ends || null, cars: b.cars || null } : null,
    truck: !!(TRUCK_ON.has(all._truck?.status) || TRUCK_ON.has(all._tfleet?.status) || TRUCK_ON.has(all._tmember?.status) || isComp(u)), truckEnds: all._truck?.ends || null,
    truckFleet: all._tfleet ? { seats: all._tfleet.seats || 0, used: (all._tfleet.members || []).length, status: all._tfleet.status } : null,
    truckCompany: all._tmember?.owner ? { company: all._tmember.company || null, on: TRUCK_ON.has(all._tmember.status), consent: !!all._tmember.consent } : null,
    carCompany: all._cmember?.owner ? { company: all._cmember.company || null, consent: !!all._cmember.consent } : null,
    carFleet: all._cfleet ? { used: (all._cfleet.members || []).length } : null };
};

// Who's calling? Used by other features later (plan limits).
async function userFromReq(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!m || !ready()) return null;
  const rows = await sb(`pc_sessions?token_hash=eq.${sha(m[1])}&expires_at=gt.${new Date().toISOString()}&select=user_id,pc_users(id,email,plan,data,created_at)`);
  return comp(rows?.[0]?.pc_users || null);
}

// ---------- abuse guard: 10 tries per 15 min per visitor ----------
const tries = new Map();
function limited(key, max = 10) {
  const k = `${key}|${Math.floor(Date.now() / 900000)}`, n = (tries.get(k) || 0) + 1;
  tries.set(k, n); if (tries.size > 20000) tries.clear();
  return n > max;
}

function readJSON(req, max) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > max) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ---------- routes ----------
function routes(url, res, send, req) {
  const p = url.pathname;
  if (!p.startsWith("/api/auth/") && p !== "/api/me") return false;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const fail = (code, error) => send(res, code, { error });

  if (p === "/api/auth/status") { send(res, 200, { ready: ready() }); return true; }
  if (!ready()) { fail(503, "Accounts aren't switched on yet."); return true; }

  if ((p === "/api/auth/signup" || p === "/api/auth/login") && req.method === "POST") {
    readJSON(req, 5000).then(async (b) => {
      const email = cleanEmail(b.email), pw = String(b.password || "");
      if (limited(ip) || limited(email, 8)) return fail(429, "Too many tries. Wait 15 minutes and try again.");
      if (!validEmail(email)) return fail(400, "Enter a valid email.");
      if (p.endsWith("signup")) {
        if (pw.length < 8) return fail(400, "Use at least 8 characters for your password.");
        if (pw.length > 200) return fail(400, "That password is too long.");
        try {
          const [u] = await sb("pc_users", { method: "POST", body: JSON.stringify({ email, pass_hash: await hashPw(pw), plan: "free", data: {} }) });
          return send(res, 200, { token: await newSession(u.id), user: pub(u) });
        } catch (e) {
          if (e.status === 409 || /duplicate|23505/.test(e.body || "")) return fail(409, "That email already has an account. Sign in instead.");
          console.error("signup:", e.message); return fail(500, "Couldn't create your account. Try again.");
        }
      }
      try {
        const [u] = await sb(`pc_users?email=eq.${encodeURIComponent(email)}&select=*`);
        if (!u || !(await checkPw(pw, u.pass_hash))) return fail(401, "Wrong email or password.");
        return send(res, 200, { token: await newSession(u.id), user: pub(u) });
      } catch (e) { console.error("login:", e.message); return fail(500, "Couldn't sign you in. Try again."); }
    }).catch(() => fail(400, "Bad request"));
    return true;
  }

  if (p === "/api/auth/logout" && req.method === "POST") {
    const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/);
    (m ? sb(`pc_sessions?token_hash=eq.${sha(m[1])}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }) : Promise.resolve())
      .then(() => send(res, 200, { ok: true })).catch(() => send(res, 200, { ok: true }));
    return true;
  }

  if (p === "/api/me" && req.method === "GET") {
    userFromReq(req).then((u) => (u ? send(res, 200, { user: pub(u) }) : fail(401, "Signed out"))).catch((e) => { console.error("me:", e.message); fail(500, "Try again."); });
    return true;
  }

  if (p === "/api/me" && req.method === "PUT") {
    Promise.all([userFromReq(req), readJSON(req, MAX_DATA)]).then(async ([u, b]) => {
      if (!u) return fail(401, "Signed out");
      if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) return fail(400, "Bad data");
      // Keys starting with _ (billing, push tokens) are server-owned: the phone can't write them, and they're kept as stored
      const keep = { ...Object.fromEntries(Object.entries(b.data).filter(([k]) => !k.startsWith("_"))),
        ...Object.fromEntries(Object.entries(u.data || {}).filter(([k]) => k.startsWith("_"))) };
      await sb(`pc_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ data: keep, updated_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" } });
      send(res, 200, { ok: true });
    }).catch((e) => fail(e.message === "too big" ? 413 : 400, e.message === "too big" ? "Too much data" : "Couldn't save."));
    return true;
  }

  // Delete account (App Store rule: must be possible inside the app). Needs the password again.
  // An active Stripe plan must be cancelled first, so nobody keeps getting billed for a deleted account.
  if (p === "/api/me" && req.method === "DELETE") {
    Promise.all([userFromReq(req), readJSON(req, 5000)]).then(async ([u, b]) => {
      if (!u) return fail(401, "Signed out");
      if (limited(ip, 5)) return fail(429, "Too many tries. Wait 15 minutes and try again.");
      const [full] = await sb(`pc_users?id=eq.${u.id}&select=pass_hash`);
      if (!full || !(await checkPw(String(b.password || ""), full.pass_hash))) return fail(401, "Wrong password.");
      const bill = u.data?._billing;
      if (bill?.sub && ["active", "trialing", "past_due"].includes(bill.status) && !bill.ends) {
        return send(res, 409, { error: "Cancel your plan first so you don't get charged again, then delete your account.", cancelFirst: true });
      }
      await sb(`plate_alerts?email=eq.${encodeURIComponent(u.email)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch((e) => console.error("delete alerts:", e.message));
      await sb(`pc_sessions?user_id=eq.${u.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      await sb(`pc_users?id=eq.${u.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      console.log("account deleted:", u.id);
      send(res, 200, { ok: true });
    }).catch((e) => { console.error("delete account:", e.message); fail(500, "Couldn't delete your account. Try again or email getrovaapp@gmail.com."); });
    return true;
  }

  fail(404, "Not found");
  return true;
}

module.exports = { isComp, routes, userFromReq, ready };
