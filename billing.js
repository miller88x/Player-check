// Payments: Stripe checkout links + a webhook that turns a driver's plan on and off.
// No Stripe secret key needed: checkout uses Stripe Payment Links (tagged with the driver's account id),
// and Stripe tells us what happened through a signed webhook (STRIPE_WEBHOOK_SECRET).
// Billing ids live on the account in data._billing { cus, sub, plan, cars, status } — the phone never sees or overwrites them.

const crypto = require("crypto");
const auth = require("./auth");

const WH_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const LIVE = process.env.STRIPE_LIVE === "1";

// Sandbox ids. When Rova goes live, copy the products to the live account and add a LIVE block here.
const STRIPE = {
  sandbox: {
    links: {
      bronze: { id: "plink_1UT7qGAYUDQyHhyYiz2Bun7N", url: "https://buy.stripe.com/test_28E5kC0Dk0tJ8ol71ud3i00" },
      silver: { id: "plink_1UT7qHAYUDQyHhyYWZzpBcCJ", url: "https://buy.stripe.com/test_5kQ4gy0Dk6S70VTbhKd3i01" },
      gold:   { id: "plink_1UT7qIAYUDQyHhyYAdMdDSoP", url: "https://buy.stripe.com/test_7sY9AS5XE6S75c9dpSd3i02" },
      fleet:  { id: "plink_1UT7qJAYUDQyHhyYUN9e43Ty", url: "https://buy.stripe.com/test_5kQ5kC3Pw3FVeMJadGd3i03" },
      // Pro Truck is an add-on (its own subscription): it never changes the driver's main plan
      protruck:    { id: "plink_1UTthKAYUDQyHhyY7RM5ime9", url: "https://buy.stripe.com/test_4gMaEW0Dk1xN0VTclOd3i04" },
      protruck_yr: { id: "plink_1UTthLAYUDQyHhyYwOBDggGY", url: "https://buy.stripe.com/test_28EcN44TAa4j6gdgC4d3i05" },
      // Pro Truck for companies: the owner picks how many trucks (2-500) at checkout; $12.99/truck, $10.99/truck at 10+
      protruck_fleet: { id: "plink_1UTtoFAYUDQyHhyYOtvQCuAw", url: "https://buy.stripe.com/test_00w9AS4TA3FV9sp1Had3i06" },
    },
    prices: {
      price_1UT7q1AYUDQyHhyY71A2AQq2: "bronze",
      price_1UT7q7AYUDQyHhyY7xLBB0GQ: "silver",
      price_1UT7q8AYUDQyHhyY78MymaCN: "gold",
      price_1UT7q9AYUDQyHhyY0RMayx2q: "fleet",
      price_1UTtfiAYUDQyHhyYzv1IqJw5: "protruck",
      price_1UTtflAYUDQyHhyYjwsCgfkN: "protruck",
      price_1UTtoCAYUDQyHhyYTe9BOwYT: "protruck_fleet",
    },
    portal: "https://billing.stripe.com/p/login/test_28E5kC0Dk0tJ8ol71ud3i00",
  },
};
const CFG = STRIPE[LIVE ? "live" : "sandbox"] || STRIPE.sandbox;
const PLAN_BY_LINK = Object.fromEntries(Object.entries(CFG.links).map(([plan, l]) => [l.id, plan]));
const ON = new Set(["active", "trialing", "past_due"]); // past_due: Stripe is still retrying the card, keep the plan meanwhile

// ---------- Supabase (same tables as accounts) ----------
const SB_URL = (process.env.SUPABASE_URL || "").replace(/[\s​-‍﻿ ]/g, "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || "").replace(/[\s​-‍﻿ ]/g, "");
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
const getUser = async (id) => (await sb(`pc_users?id=eq.${encodeURIComponent(id)}&select=id,email,plan,data`))?.[0] || null;
const userBySub = async (sub) => (await sb(`pc_users?data->_billing->>sub=eq.${encodeURIComponent(sub)}&select=id,email,plan,data`))?.[0] || null;
const userByTruckSub = async (sub) => (await sb(`pc_users?data->_truck->>sub=eq.${encodeURIComponent(sub)}&select=id,email,plan,data`))?.[0] || null;
const isTruck = (plan) => plan === "protruck" || plan === "protruck_yr";
const userByTFleetSub = async (sub) => (await sb(`pc_users?data->_tfleet->>sub=eq.${encodeURIComponent(sub)}&select=id,email,plan,data`))?.[0] || null;
const userByCFleetCode = async (code) => (await sb(`pc_users?data->_cfleet->>code=eq.${encodeURIComponent(code)}&select=id,email,plan,data`))?.[0] || null;
const userByTFleetCode = async (code) => (await sb(`pc_users?data->_tfleet->>code=eq.${encodeURIComponent(code)}&select=id,email,plan,data`))?.[0] || null;
const newCode = () => Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[crypto.randomInt(32)]).join("");
// Trucks paid for, from the checkout total: volume price $12.99 each under 10, $10.99 each at 10+
const seatsFromTotal = (cents) => (cents >= 10 * 1099 && cents % 1099 === 0 ? cents / 1099 : cents % 1299 === 0 ? cents / 1299 : Math.max(2, Math.round(cents / 1299)));
async function patchData(u, patch) {
  const data = { ...(u.data || {}), ...patch };
  await sb(`pc_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ data, updated_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" } });
  u.data = data;
}
// Company Pro Truck lives on the owner in data._tfleet { cus, sub, status, seats, code, members:[userId] };
// each driver gets data._tmember { owner, status } so their phone knows truck routes are on.
async function setTFleet(u, f) {
  const cur = (u.data || {})._tfleet || {};
  const next = { members: [], code: newCode(), ...cur, ...f, at: new Date().toISOString() };
  await patchData(u, { _tfleet: next });
  for (const id of next.members || []) { try { const m = await getUser(id); if (m) await patchData(m, { _tmember: { ...(m.data?._tmember || {}), owner: u.id, status: next.status } }); } catch (e) { console.error("tfleet member:", e.message); } }
  console.log(`billing: ${u.email} truck fleet -> ${next.status}, ${next.seats} trucks`);
}
// Pro Truck lives in data._truck { cus, sub, status, ends } next to the main plan
async function setTruck(u, truck) {
  const data = { ...(u.data || {}), _truck: { ...((u.data || {})._truck || {}), ...truck, at: new Date().toISOString() } };
  await sb(`pc_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ data, updated_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" } });
  console.log(`billing: ${u.email} pro truck -> ${truck.status}`);
}
async function setPlan(u, plan, billing) {
  const data = { ...(u.data || {}), _billing: { ...((u.data || {})._billing || {}), ...billing, at: new Date().toISOString() } };
  await sb(`pc_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ plan, data, updated_at: new Date().toISOString() }), headers: { Prefer: "return=minimal" } });
  console.log(`billing: ${u.email} -> ${plan}`);
}

// ---------- webhook signature (Stripe-Signature: t=...,v1=...) ----------
function verify(raw, header) {
  if (!WH_SECRET) return false;
  const parts = Object.fromEntries(String(header || "").split(",").map((x) => x.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header || "").split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac("sha256", WH_SECRET).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

async function handle(ev) {
  const o = ev.data?.object || {};
  if (ev.type === "checkout.session.completed") {
    if (o.mode !== "subscription" || !o.client_reference_id) return;
    const plan = PLAN_BY_LINK[o.payment_link];
    const u = plan && (await getUser(o.client_reference_id));
    if (!u) return console.warn("billing: checkout with no matching account/plan", o.id);
    if (isTruck(plan)) return setTruck(u, { cus: o.customer, sub: o.subscription, status: "active", ends: null });
    if (plan === "protruck_fleet") return setTFleet(u, { cus: o.customer, sub: o.subscription, status: "active", ends: null, seats: seatsFromTotal(o.amount_subtotal || 0) });
    await setPlan(u, plan, { cus: o.customer, sub: o.subscription, plan, status: "active" });
    return;
  }
  if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
    if (CFG.prices[o.items?.data?.[0]?.price?.id] === "protruck_fleet") {
      const f = await userByTFleetSub(o.id); if (!f) return;
      const on = ev.type === "customer.subscription.updated" && ON.has(o.status);
      return setTFleet(f, { status: on ? o.status : ev.type.endsWith("deleted") ? "canceled" : o.status, seats: o.items.data[0].quantity || f.data._tfleet.seats, ends: o.cancel_at_period_end ? o.current_period_end || o.items?.data?.[0]?.current_period_end || null : null });
    }
    if (CFG.prices[o.items?.data?.[0]?.price?.id] === "protruck") {
      const t = await userByTruckSub(o.id); if (!t) return;
      const on = ev.type === "customer.subscription.updated" && ON.has(o.status);
      return setTruck(t, { status: on ? o.status : ev.type.endsWith("deleted") ? "canceled" : o.status, ends: o.cancel_at_period_end ? o.current_period_end || o.items?.data?.[0]?.current_period_end || null : null });
    }
    const u = await userBySub(o.id);
    if (!u) return; // checkout event hasn't landed yet; it sets the plan itself
    const item = o.items?.data?.[0];
    const plan = CFG.prices[item?.price?.id] || u.data?._billing?.plan || "free";
    const on = ev.type === "customer.subscription.updated" && ON.has(o.status);
    await setPlan(u, on ? plan : "free", { plan, status: ev.type.endsWith("deleted") ? "canceled" : o.status, cars: plan === "fleet" ? item?.quantity || null : null, ends: o.cancel_at_period_end ? o.current_period_end || item?.current_period_end || null : null });
  }
}

function readRaw(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- routes ----------
function routes(url, res, send, req) {
  const p = url.pathname;
  if (!p.startsWith("/api/billing/")) return false;

  // Stripe -> Rova
  if (p === "/api/billing/webhook" && req.method === "POST") {
    readRaw(req).then(async (raw) => {
      if (!verify(raw, req.headers["stripe-signature"])) return send(res, 400, { error: "bad signature" });
      try { await handle(JSON.parse(raw)); send(res, 200, { received: true }); }
      catch (e) { console.error("billing webhook:", e.message); send(res, 500, { error: "retry" }); } // Stripe retries on 5xx
    }).catch(() => send(res, 400, { error: "bad request" }));
    return true;
  }

  // Phone -> checkout link for the signed-in driver
  if (p === "/api/billing/link" && req.method === "GET") {
    const plan = url.searchParams.get("plan");
    const link = CFG.links[plan];
    if (!link) { send(res, 400, { error: "Pick a plan." }); return true; }
    auth.userFromReq(req).then((u) => {
      if (!u) return send(res, 401, { error: "Sign in first." });
      const b = u.data?._billing, tr = u.data?._truck;
      if (isTruck(plan)) { if (tr?.sub && ON.has(tr.status)) return send(res, 409, { error: "You already have Pro Truck. Manage it from Manage plan.", portal: manageUrl(u) }); }
      else if (plan === "protruck_fleet") { if (ON.has(u.data?._tfleet?.status)) return send(res, 409, { error: "Your company already has Pro Truck. Change the number of trucks from Manage plan.", portal: manageUrl(u) }); }
      else if (u.plan !== "free" && b?.sub && ON.has(b.status)) return send(res, 409, { error: "You already have a plan. Change it from Manage plan.", portal: manageUrl(u) });
      const q = new URLSearchParams({ client_reference_id: u.id, prefilled_email: u.email });
      send(res, 200, { url: `${link.url}?${q}` });
    }).catch((e) => { console.error("billing link:", e.message); send(res, 500, { error: "Try again." }); });
    return true;
  }

  // ---------- Pro Truck for companies: invite codes ----------
  if (p.startsWith("/api/billing/truckfleet") || p === "/api/billing/carfleet") {
    const body = () => (req.method === "POST" ? readRaw(req, 2e4).then((r) => JSON.parse(r || "{}")) : Promise.resolve({}));
    Promise.all([auth.userFromReq(req), body()]).then(async ([u, b]) => {
      if (!u) return send(res, 401, { error: "Sign in first." });
      const f = u.data?._tfleet;
      if (p === "/api/billing/carfleet" && req.method === "POST") { // car Fleet owner: get (or make) the drivers' join code
        if (u.plan !== "fleet" || !ON.has(u.data?._billing?.status)) return send(res, 403, { error: "Driver codes come with the Fleet plan." });
        const cf = u.data?._cfleet || { code: newCode(), members: [] };
        if (b.newCode) cf.code = newCode();
        if (b.remove) cf.members = (cf.members || []).filter((x) => x !== b.remove);
        await patchData(u, { _cfleet: cf });
        if (b.remove) { const m = await getUser(b.remove).catch(() => null); if (m && m.data?._cmember?.owner === u.id) await patchData(m, { _cmember: null }); }
        const members = []; for (const id of cf.members || []) { const m = await getUser(id).catch(() => null); if (m) members.push({ id: m.id, email: m.email }); }
        return send(res, 200, { code: cf.code, seats: Math.max(3, u.data?._billing?.cars || 3), members });
      }
      if (p === "/api/billing/truckfleet" && req.method === "GET") { // owner's view
        if (!f) return send(res, 404, { error: "No company plan." });
        const members = [];
        for (const id of f.members || []) { const m = await getUser(id).catch(() => null); if (m) members.push({ id: m.id, email: m.email }); }
        return send(res, 200, { code: f.code, seats: f.seats || 0, status: f.status, ends: f.ends || null, members });
      }
      if (p === "/api/billing/truckfleet/join" && req.method === "POST") {
        const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (code.length !== 8) return send(res, 400, { error: "Enter the 8-letter code from your company." });
        const consent = b.consent ? new Date().toISOString() : null;
        const o = await userByTFleetCode(code);
        if (!o) { // a car Fleet company code: joins for live location (and ticket checks), no truck routes
          const c = await userByCFleetCode(code);
          if (!c || c.plan !== "fleet" || !ON.has(c.data?._billing?.status)) return send(res, 404, { error: "That code isn't active. Check it with your company." });
          if (c.id === u.id) return send(res, 400, { error: "That's your own company code. Share it with your drivers." });
          if (!consent) return send(res, 400, { error: "Agree to share your location while on duty to join." });
          const cf = c.data._cfleet, mem = cf.members || [], seats = Math.max(3, c.data._billing?.cars || 3);
          if (!mem.includes(u.id)) { if (mem.length >= seats) return send(res, 409, { error: `All ${seats} driver spots are taken. Ask your company to add cars.` }); await patchData(c, { _cfleet: { ...cf, members: [...mem, u.id] } }); }
          await patchData(u, { _cmember: { owner: c.id, company: c.email, consent } });
          return send(res, 200, { ok: true, company: c.email, kind: "car" });
        }
        if (!ON.has(o.data?._tfleet?.status)) return send(res, 404, { error: "That code isn't active. Check it with your company." });
        const of = o.data._tfleet, members = of.members || [];
        if (o.id === u.id) return send(res, 400, { error: "That's your own company code: you already have truck routes. Share it with your drivers." });
        if (!members.includes(u.id)) {
          if (members.length >= (of.seats || 0)) return send(res, 409, { error: `All ${of.seats} driver spots are taken. Ask your company to add trucks.` });
          await setTFleet(o, { members: [...members, u.id] });
        }
        await patchData(u, { _tmember: { owner: o.id, status: of.status, company: o.email, consent } });
        return send(res, 200, { ok: true, company: o.email, kind: "truck" });
      }
      if (p === "/api/billing/truckfleet/leave" && req.method === "POST") {
        const m = u.data?._tmember;
        if (m?.owner) { const o = await getUser(m.owner).catch(() => null); if (o?.data?._tfleet) await patchData(o, { _tfleet: { ...o.data._tfleet, members: (o.data._tfleet.members || []).filter((x) => x !== u.id) } }); }
        const cm = u.data?._cmember;
        if (cm?.owner) { const o = await getUser(cm.owner).catch(() => null); if (o?.data?._cfleet) await patchData(o, { _cfleet: { ...o.data._cfleet, members: (o.data._cfleet.members || []).filter((x) => x !== u.id) } }); }
        await patchData(u, { _tmember: null, _cmember: null });
        return send(res, 200, { ok: true });
      }
      if (!f) return send(res, 404, { error: "No company plan." });
      if (p === "/api/billing/truckfleet/remove" && req.method === "POST") {
        const id = String(b.id || "");
        await patchData(u, { _tfleet: { ...f, members: (f.members || []).filter((x) => x !== id) } });
        const m = await getUser(id).catch(() => null);
        if (m && m.data?._tmember?.owner === u.id) await patchData(m, { _tmember: null });
        return send(res, 200, { ok: true });
      }
      if (p === "/api/billing/truckfleet/newcode" && req.method === "POST") { // old code stops working; drivers who joined stay
        const code = newCode(); await patchData(u, { _tfleet: { ...f, code } });
        return send(res, 200, { code });
      }
      send(res, 404, { error: "Not found" });
    }).catch((e) => { console.error("truckfleet:", e.message); send(res, 500, { error: "Try again." }); });
    return true;
  }

  if (p === "/api/billing/portal" && req.method === "GET") {
    auth.userFromReq(req).then((u) => (u ? send(res, 200, { url: manageUrl(u) }) : send(res, 401, { error: "Sign in first." })))
      .catch(() => send(res, 500, { error: "Try again." }));
    return true;
  }

  send(res, 404, { error: "Not found" });
  return true;
}
const manageUrl = (u) => `${CFG.portal}?${new URLSearchParams({ prefilled_email: u.email })}`;

// Does this account have Pro Truck right now? (paid add-on, or comped test/reviewer accounts)
const hasTruck = (u) => !!u && (ON.has(u.data?._truck?.status) || ON.has(u.data?._tfleet?.status) || ON.has(u.data?._tmember?.status) || auth.isComp?.(u));
module.exports = { routes, verify, handle, hasTruck, getUser, patchData, ON, ready: () => !!WH_SECRET };
