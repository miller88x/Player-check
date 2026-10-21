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
    },
    prices: {
      price_1UT7q1AYUDQyHhyY71A2AQq2: "bronze",
      price_1UT7q7AYUDQyHhyY7xLBB0GQ: "silver",
      price_1UT7q8AYUDQyHhyY78MymaCN: "gold",
      price_1UT7q9AYUDQyHhyY0RMayx2q: "fleet",
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
    await setPlan(u, plan, { cus: o.customer, sub: o.subscription, plan, status: "active" });
    return;
  }
  if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
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
      const b = u.data?._billing;
      if (u.plan !== "free" && b?.sub && ON.has(b.status)) return send(res, 409, { error: "You already have a plan. Change it from Manage plan.", portal: manageUrl(u) });
      const q = new URLSearchParams({ client_reference_id: u.id, prefilled_email: u.email });
      send(res, 200, { url: `${link.url}?${q}` });
    }).catch((e) => { console.error("billing link:", e.message); send(res, 500, { error: "Try again." }); });
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

module.exports = { routes, verify, handle, ready: () => !!WH_SECRET };
