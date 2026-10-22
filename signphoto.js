// Point the camera at a parking sign: Claude reads the photo, Rova's own sign reader works out the answer for right now.
// Paid (Bronze and up) because each read costs an AI call. Needs ANTHROPIC_API_KEY.

const auth = require("./auth");
const park = require("./park");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.SIGN_MODEL || "claude-sonnet-5-5"; // reading small print on a street sign needs the stronger model
const PAID = ["bronze", "silver", "gold", "fleet"];

const PROMPT = `You read New York City parking signs from a driver's photo.
Return ONLY JSON: {"signs":[{"text":"...","arrow":"left|right|both|none"}],"readable":true|false,"note":"..."}
- One entry per sign panel, top to bottom, in the city's own wording style, e.g.
  "NO PARKING (SANITATION BROOM SYMBOL) 8AM-9:30AM TUES & FRI", "NO STANDING 7AM-10AM 4PM-7PM EXCEPT SUNDAY",
  "2 HOUR METERED PARKING 9AM-7PM EXCEPT SUNDAY", "NO STOPPING ANYTIME", "TRUCK LOADING ONLY 7AM-7PM EXCEPT SUNDAY",
  "AUTHORIZED VEHICLES ONLY NYPD", "BUS STOP", "TAXI STAND".
- Keep times, days, months and "EXCEPT" exactly as printed. Write times like 8AM, 9:30AM, NOON, MIDNIGHT.
- arrow: the direction the arrow on that panel points as seen in the photo; "none" if there is no arrow.
- Skip panels that are not parking rules (street names, one-way, bus route panels, idling notices).
- If the photo is not a parking sign or is too blurry to read, return {"signs":[],"readable":false,"note":"why, in a few words"}.`;

async function readPhoto(b64, mime) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system: PROMPT,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: "Read the parking signs in this photo." }] }] }),
    signal: AbortSignal.timeout(40000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `AI ${res.status}`);
  const t = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Couldn't read the signs.");
  return JSON.parse(m[0]);
}

// What the signs mean right now, using the same reader and holiday calendar as the map
function answer(signs, at = new Date()) {
  const now = park.nyNow(at);
  const rules = signs.map((s) => ({ s, r: park.parseSign(s.text) })).filter((x) => x.r);
  let red = null, redW = null, yellow = null, next = null;
  for (const { r } of rules) {
    if (r.noHours) continue;
    for (const w of park.schedule(r, now)) {
      if (w.start <= 0 && w.end > 0) { if (r.kind === "meter") yellow = yellow || r; else if (!red || w.end > redW.end) { red = r; redW = w; } }
      else if (w.start > 0 && r.kind !== "meter" && (!next || w.start < next.w.start)) next = { r, w };
    }
  }
  const when = (mins) => new Date(at.getTime() + mins * 60000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  let status, headline, detail, moveBy = null;
  if (red) {
    status = "red";
    headline = red.kind === "reserved" ? `You can't park here: ${red.label.replace(/^./, (x) => x.toLowerCase())}` : red.anytime ? `${red.label} anytime` : `${red.label} right now`;
    detail = red.anytime ? "You can't leave the car here." : `Until ${when(redW.end)}.`;
  } else if (yellow) {
    status = "yellow"; headline = `${yellow.label} now`;
    detail = `${yellow.paid ? "Pay at the muni-meter or with the ParkNYC app." : `${yellow.hours}-hour limit.`}${next ? ` Then ${next.r.label.toLowerCase()} ${when(next.w.start)}.` : ""}`;
    if (next) moveBy = new Date(at.getTime() + next.w.start * 60000).toISOString();
  } else if (rules.length) {
    status = "green";
    if (next && next.w.start <= 7 * 1440) { headline = `You can park until ${when(next.w.start)}`; detail = `${next.r.label} starts then.`; moveBy = new Date(at.getTime() + next.w.start * 60000).toISOString(); }
    else { headline = "You can park here"; detail = "None of these signs apply this week."; }
  } else { status = "unknown"; headline = "Couldn't find a parking rule"; detail = "Try again closer, with the whole sign in the frame."; }
  const arrows = signs.filter((s) => s.arrow && s.arrow !== "none").length;
  return { status, headline, detail, moveBy, rules: rules.map((x) => park.describe(x.r)),
    arrowNote: arrows ? "Arrows show which side of the sign each rule covers. Make sure your car is on that side." : "" };
}

const tries = new Map();
function routes(url, res, send, req) {
  if (url.pathname !== "/api/park/photo" || req.method !== "POST") return false;
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > 6e6) req.destroy(); else chunks.push(c); });
  req.on("end", async () => {
    try {
      const u = await auth.userFromReq(req).catch(() => null);
      if (!u) return send(res, 401, { error: "Sign in to read signs with your camera." });
      if (!PAID.includes(u.plan)) return send(res, 402, { error: "Sign photo reading is part of Bronze and up.", upgrade: true });
      if (!API_KEY) return send(res, 503, { error: "Sign reading isn't switched on yet." });
      const k = `${u.id}|${new Date().toISOString().slice(0, 10)}`, n = (tries.get(k) || 0) + 1; tries.set(k, n); if (tries.size > 20000) tries.clear();
      if (n > 40) return send(res, 429, { error: "That's a lot of signs today. Try again tomorrow." });
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const m = String(b.image || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return send(res, 400, { error: "Send a photo." });
      const read = await readPhoto(m[2], m[1]);
      if (!read.readable || !read.signs?.length) return send(res, 200, { status: "unknown", headline: "Couldn't read a parking sign", detail: read.note || "Try again closer, with the whole sign in the frame and no glare.", signs: [] });
      send(res, 200, { ...answer(read.signs), signs: read.signs });
    } catch (e) { console.error("sign photo:", e.message); send(res, 502, { error: "Couldn't read the photo. Try again." }); }
  });
  return true;
}

module.exports = { routes, answer };
