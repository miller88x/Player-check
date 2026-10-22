// Move-your-car warnings for the saved parked spot, even with Rova closed (store apps, phone notifications).
// Every 5 minutes: for each signed-in driver with a parked car, re-read the rules at that spot (so holiday
// street-cleaning cancellations count), then notify 60 and 15 minutes before a rule starts. Each morning
// (6–9 AM) a driver whose street cleaning is cancelled today gets "no need to move". Free for every plan.
// Note: on Render's free plan the server sleeps when idle; the Starter plan keeps these on time.

const park = require("./park");
const push = require("./push");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/[\s​-‍﻿ ]/g, "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || "").replace(/[\s​-‍﻿ ]/g, "");
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts,
    headers: { apikey: SB_KEY, ...(SB_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}), "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000) });
  const t = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}
async function saveState(id, st) {
  const [u] = await sb(`pc_users?id=eq.${id}&select=data`);
  if (!u) return;
  const data = { ...(u.data || {}), _park: st };
  await sb(`pc_users?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ data }), headers: { Prefer: "return=minimal" } });
}
const clock = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const nyHour = () => +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date()) % 24;
const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

// What a driver should hear right now, given the spot's fresh answer (pure function: easy to test)
function decide(car, fresh, st, now = Date.now(), hour = nyHour(), today = nyDay()) {
  const out = [];
  const key = `${car.savedAt}`;
  if (st.key !== key) st = { key, sent: {} };
  const moveBy = fresh?.moveBy || car.moveBy;
  if (fresh?.status === "red" && !st.sent.red) { // rules changed under the car (temporary sign, new rule)
    out.push({ k: "red", title: "Your car may be in a no-parking zone", body: `${fresh.headline} at ${car.where || "your spot"}. Check the signs.` });
  }
  if (moveBy) {
    const mins = (new Date(moveBy) - now) / 60000;
    if (mins <= 62 && mins > 16 && !st.sent[`60:${moveBy}`]) out.push({ k: `60:${moveBy}`, title: "Move your car in 1 hour", body: `${car.where || "Your spot"}: parking rules start ${clock(moveBy)}.` });
    if (mins <= 16 && mins > -5 && !st.sent[`15:${moveBy}`]) out.push({ k: `15:${moveBy}`, title: "Move your car now", body: `Rules start at ${clock(moveBy).split(" ").slice(1).join(" ")} at ${car.where || "your spot"}. Tickets start then.` });
  }
  if (fresh?.suspendedToday && fresh.sweeping && hour >= 6 && hour < 10 && !st.sent[`asp:${today}`]) {
    out.push({ k: `asp:${today}`, title: "No need to move your car today", body: `Street cleaning is cancelled today (${fresh.suspendedToday}).${fresh.moveBy ? ` Next move-by: ${clock(fresh.moveBy)}.` : ""}` });
  }
  for (const m of out) st.sent[m.k] = new Date(now).toISOString();
  return { msgs: out, st };
}

let running = false;
async function tick() {
  if (running || !SB_URL || !SB_KEY || !push.ready()) return;
  running = true;
  try {
    const users = await sb(`pc_users?data->parked=not.is.null&data->_push->tokens=not.is.null&select=id,email,plan,data`);
    for (const u of users) {
      const car = u.data?.parked;
      if (!car?.at || !(u.data._push?.tokens || []).length) continue;
      if (Date.now() - (car.savedAt || 0) > 14 * 864e5) continue; // a spot from two weeks ago is stale
      const due = car.moveBy && new Date(car.moveBy) - Date.now() < 70 * 60000 && new Date(car.moveBy) - Date.now() > -10 * 60000;
      const morning = nyHour() >= 6 && nyHour() < 10;
      if (!due && !morning) continue; // nothing could fire now: skip the sign lookup
      let fresh = null;
      try { fresh = await park.check(car.at[1], car.at[0]); } catch {}
      const { msgs, st } = decide(car, fresh, { ...(u.data._park || {}), sent: { ...(u.data._park?.sent || {}) } });
      for (const m of msgs) await push.sendToUser(u, m.title, m.body, { open: "parked" }).catch(() => 0);
      if (msgs.length) await saveState(u.id, st).catch((e) => console.error("parkwatch save:", e.message));
    }
  } catch (e) { console.error("parkwatch:", e.message); }
  running = false;
}
function start() { setInterval(tick, 5 * 60 * 1000).unref(); setTimeout(tick, 60 * 1000).unref(); }

module.exports = { start, decide, tick };
