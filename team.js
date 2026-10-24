// Live fleet map: company drivers share where they are while ON DUTY, and only with their own company.
// Drivers agree when they join (NY requires written notice before an employer tracks employees electronically)
// and can go off duty anytime. Positions live in server memory: the latest spot and today's route (trimmed after 14 hours).
const auth = require("./auth");
const billing = require("./billing");

const live = new Map(); // driverId -> { owner, lat, lng, heading, mph, at, trail: [[lng, lat, t]] }
const KEEP = 14 * 3600e3, STALE = 10 * 60e3;
const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : null);
const distM = (a, b) => Math.hypot((b[0] - a[0]) * 84300, (b[1] - a[1]) * 111200);
const ownerOf = (u) => u?.data?._tmember?.owner || u?.data?._cmember?.owner || null;
const membersOf = (u) => [...new Set([...(u?.data?._tfleet?.members || []), ...(u?.data?._cfleet?.members || [])])];
const isOwner = (u) => !!u && (billing.ON.has(u.data?._tfleet?.status) || (u.plan === "fleet" && billing.ON.has(u.data?._billing?.status)));
const names = new Map(); // id -> { email, at }
async function emailOf(id) {
  const c = names.get(id); if (c && Date.now() - c.at < 10 * 60e3) return c.email;
  const u = await billing.getUser(id).catch(() => null); const email = u?.email || "driver";
  names.set(id, { email, at: Date.now() }); return email;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of live) { v.trail = v.trail.filter((p) => t - p[2] < KEEP); if (t - v.at > KEEP) live.delete(k); } }, 10 * 60e3).unref();

function readJSON(req) {
  return new Promise((ok, bad) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 4000) { bad(new Error("big")); req.destroy(); } }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { bad(e); } }); req.on("error", bad); });
}

function routes(url, res, send, req) {
  const p = url.pathname;
  if (!p.startsWith("/api/team/")) return false;
  (async () => {
    const u = await auth.userFromReq(req).catch(() => null);
    if (!u) return send(res, 401, { error: "Sign in first." });

    // Driver agrees (or takes back) location sharing with their company
    if (p === "/api/team/consent" && req.method === "POST") {
      const b = await readJSON(req), at = b.on ? new Date().toISOString() : null, patch = {};
      if (u.data?._tmember) patch._tmember = { ...u.data._tmember, consent: at };
      if (u.data?._cmember) patch._cmember = { ...u.data._cmember, consent: at };
      if (!Object.keys(patch).length) return send(res, 403, { error: "Not part of a company." });
      await billing.patchData(u, patch); if (!at) live.delete(u.id);
      return send(res, 200, { ok: true });
    }
    // Driver's phone -> where I am (only while on duty, only after agreeing)
    if (p === "/api/team/ping" && req.method === "POST") {
      const owner = ownerOf(u);
      if (!owner) return send(res, 403, { error: "Not part of a company." });
      if (!(u.data?._tmember?.consent || u.data?._cmember?.consent)) return send(res, 403, { error: "Location sharing is off." });
      const b = await readJSON(req);
      if (b.off) { live.delete(u.id); return send(res, 200, { ok: true }); }
      const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
      if (lat == null || lng == null) return send(res, 400, { error: "bad position" });
      const now = Date.now(), cur = live.get(u.id) || { trail: [] };
      const last = cur.trail[cur.trail.length - 1];
      if (!last || distM(last, [lng, lat]) > 25 || now - last[2] > 120e3) cur.trail.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, now]);
      if (cur.trail.length > 4000) cur.trail.splice(0, cur.trail.length - 4000);
      live.set(u.id, { ...cur, owner, lat, lng, heading: num(b.heading, 0, 360), mph: num(b.mph, 0, 150) == null ? null : Math.round(b.mph), nav: !!b.nav, to: String(b.to || "").slice(0, 60) || null, at: now });
      return send(res, 200, { ok: true });
    }

    // Owner -> all my drivers right now
    if (p === "/api/team/live" && req.method === "GET") {
      if (!isOwner(u)) return send(res, 403, { error: "The live map comes with Fleet and Pro Truck for companies." });
      const out = [];
      for (const id of membersOf(u)) {
        const v = live.get(id), email = await emailOf(id);
        const on = v && v.owner === u.id && Date.now() - v.at < STALE;
        out.push({ id, email, on: !!on, lat: on ? v.lat : null, lng: on ? v.lng : null, heading: on ? v.heading : null, mph: on ? v.mph : null, nav: on ? v.nav : false, to: on ? v.to : null, at: v && v.owner === u.id ? v.at : null,
          kind: (u.data?._tfleet?.members || []).includes(id) ? "truck" : "car" });
      }
      return send(res, 200, { drivers: out });
    }

    // Owner -> one driver's route today
    if (p === "/api/team/trail" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      if (!isOwner(u) || !membersOf(u).includes(id)) return send(res, 403, { error: "Not your driver." });
      const v = live.get(id);
      const since = Date.now() - 14 * 3600e3;
      return send(res, 200, { trail: v && v.owner === u.id ? v.trail.filter((x) => x[2] > since) : [] });
    }
    send(res, 404, { error: "Not found" });
  })().catch((e) => { console.error("team:", e.message); send(res, 500, { error: "Try again." }); });
  return true;
}

module.exports = { routes, _live: live };
