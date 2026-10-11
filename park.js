// "Can I park here?" — reads NYC DOT parking signs near a spot and works out what applies right now.
// Data: Parking Regulation Locations and Signs (nfid-uabd). Sign positions are in NY State Plane (feet).

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const SIGNS = "https://data.cityofnewyork.us/resource/nfid-uabd.json";

// ---------- lat/lng <-> NY State Plane Long Island (EPSG:2263, US feet) ----------
const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, E = Math.sqrt(E2), FT = 1200 / 3937;
const rad = (d) => (d * Math.PI) / 180;
const LAT1 = rad(41 + 2 / 60), LAT2 = rad(40 + 40 / 60), LAT0 = rad(40 + 10 / 60), LON0 = rad(-74), FE = 300000, FN = 0;
const mF = (p) => Math.cos(p) / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
const tF = (p) => Math.tan(Math.PI / 4 - p / 2) / ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2);
const N = (Math.log(mF(LAT1)) - Math.log(mF(LAT2))) / (Math.log(tF(LAT1)) - Math.log(tF(LAT2)));
const FF = mF(LAT1) / (N * tF(LAT1) ** N);
const R0 = A * FF * tF(LAT0) ** N;
function toStatePlane(lat, lng) {
  const r = A * FF * tF(rad(lat)) ** N, th = N * (rad(lng) - LON0);
  return [(FE + r * Math.sin(th)) / FT, (FN + R0 - r * Math.cos(th)) / FT];
}
function toLatLng(x, y) {
  const dx = x * FT - FE, dy = R0 - (y * FT - FN);
  const r = Math.sign(N) * Math.hypot(dx, dy), t = (r / (A * FF)) ** (1 / N), th = Math.atan2(dx, dy);
  let p = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) p = Math.PI / 2 - 2 * Math.atan(t * ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2));
  return [(p * 180) / Math.PI, ((th / N + LON0) * 180) / Math.PI];
}

// ---------- Reading sign text ----------
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAYNAME = { SUN: "Sun", MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat" };
const DAY_RE = /\b(SUN(?:DAY)?|MON(?:DAY)?|TUE(?:S|SDAY)?|WED(?:NESDAY)?|THU(?:R|RS|RSDAY)?|FRI(?:DAY)?|SAT(?:URDAY)?)\b/g;
const dayIdx = (w) => DAYS.indexOf(w.slice(0, 3));

function parseTime(h, m, ap) {
  ap = (ap || "").toUpperCase();
  if (ap === "NOON") return 12 * 60;
  if (ap === "MIDNIGHT") return 24 * 60;
  let hh = +h % 12; if (ap === "PM") hh += 12;
  return hh * 60 + (+m || 0);
}

function parseSign(desc) {
  const d = String(desc || "").toUpperCase().replace(/\(SUPERSEDES[^)]*\)/g, "").replace(/\s+/g, " ").trim();
  let kind = null;
  if (/NO STOPPING/.test(d)) kind = "stop";
  else if (/NO STANDING/.test(d)) kind = "stand";
  else if (/NO PARKING/.test(d)) kind = "park";
  else if (/(\d+|ONE|TWO|THREE|1\/2)\s*(HOUR|HR|MIN)/.test(d) || /METER|PAY-?BY|PAY BY|MUNI/.test(d)) kind = "meter";
  if (!kind) return null;

  // Time windows like 8AM-9:30AM, 7:30AM-NOON, MIDNIGHT-3AM
  const windows = [];
  const re = /(?:(\d{1,2})(?::(\d{2}))?\s*(AM|PM)|(NOON|MIDNIGHT))\s*(?:-|TO)\s*(?:(\d{1,2})(?::(\d{2}))?\s*(AM|PM)|(NOON|MIDNIGHT))/g;
  let m;
  while ((m = re.exec(d))) {
    const s = m[4] ? parseTime(0, 0, m[4]) : parseTime(m[1], m[2], m[3]);
    const e = m[8] ? parseTime(0, 0, m[8]) : parseTime(m[5], m[6], m[7]);
    windows.push([s === 24 * 60 ? 0 : s, e === 0 ? 24 * 60 : e]);
  }
  const anytime = /ANYTIME/.test(d) || (!windows.length && kind !== "meter");

  // Days
  let days = null;
  const range = d.match(/\b(SUN|MON|TUE|WED|THU|FRI|SAT)[A-Z]*\s*(?:THRU|THROUGH|-|TO)\s*(SUN|MON|TUE|WED|THU|FRI|SAT)/);
  if (range) {
    days = []; let i = dayIdx(range[1]); const j = dayIdx(range[2]);
    for (let k = 0; k < 7; k++) { days.push(i); if (i === j) break; i = (i + 1) % 7; }
  } else if (/SCHOOL DAYS/.test(d)) days = [1, 2, 3, 4, 5];
  else {
    const exc = d.match(/EXCEPT\s+(SUN(?:DAY)?|SAT(?:URDAY)?)(?:\s*(?:&|AND|,)\s*(SUN(?:DAY)?|SAT(?:URDAY)?))?/);
    const listed = [...d.replace(/EXCEPT.*$/, "").matchAll(DAY_RE)].map((x) => dayIdx(x[1]));
    if (listed.length) days = [...new Set(listed)];
    else if (exc) { const skip = [exc[1], exc[2]].filter(Boolean).map(dayIdx); days = [0, 1, 2, 3, 4, 5, 6].filter((x) => !skip.includes(x)); }
  }
  if (!days || !days.length) days = [0, 1, 2, 3, 4, 5, 6];

  const sweeping = /BROOM|SANITATION/.test(d);
  const limit = d.match(/(\d+|ONE|TWO|THREE)\s*(HOUR|HR)/);
  const commercial = /COMMERCIAL|TRUCK|LOADING/.test(d) && kind !== "meter";
  const label = {
    stop: "No stopping", stand: "No standing", park: sweeping ? "Street cleaning: no parking" : "No parking",
    meter: limit ? `${limit[1] === "ONE" ? 1 : limit[1] === "TWO" ? 2 : limit[1] === "THREE" ? 3 : limit[1]}-hour metered parking` : "Metered parking",
  }[kind];
  return { kind, sweeping, commercial, anytime, days, windows: anytime ? [[0, 24 * 60]] : windows.length ? windows : [[0, 24 * 60]], label, raw: d.replace(/\s*<?-+>?\s*$/, "").replace(/<->|-->|<--/g, "").trim() };
}

// ---------- Is it in force now, and when next? ----------
function nyNow(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { day: DAYS.indexOf(p.weekday.toUpperCase()), min: (+p.hour % 24) * 60 + +p.minute };
}
// minutes from now until each start/end over the next 7 days
function schedule(rule, now) {
  const out = [];
  for (let k = 0; k <= 7; k++) {
    const day = (now.day + k) % 7;
    if (!rule.days.includes(day)) continue;
    for (const [s, e] of rule.windows) out.push({ start: k * 1440 + s - now.min, end: k * 1440 + e - now.min, day, s, e });
  }
  return out.sort((a, b) => a.start - b.start);
}
const fmtClock = (min) => { min = ((min % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = min % 60; return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`; };
function fmtWhen(w, now) {
  const dd = (w.day - now.day + 7) % 7;
  const prefix = w.start < 0 ? "" : dd === 0 ? "today " : dd === 1 ? "tomorrow " : `${DAYNAME[DAYS[w.day]]} `;
  return `${prefix}${fmtClock(w.s)}`;
}
function describe(rule) {
  if (rule.anytime) return `${rule.label} anytime`;
  const days = rule.days.length === 7 ? "every day" : rule.days.length === 6 ? `except ${DAYNAME[DAYS[[0,1,2,3,4,5,6].find((x) => !rule.days.includes(x))]]}` :
    rule.days.join() === "1,2,3,4,5" ? "Mon–Fri" : rule.days.map((x) => DAYNAME[DAYS[x]]).join(", ");
  return `${rule.label} ${rule.windows.map(([s, e]) => `${fmtClock(s)}–${fmtClock(e)}`).join(", ")} · ${days}`;
}

async function signsNear(lat, lng, radiusFt = 260) {
  const [x, y] = toStatePlane(lat, lng);
  const params = new URLSearchParams({
    $select: "on_street,from_street,to_street,side_of_street,sign_x_coord,sign_y_coord,sign_description,arrow_direction",
    $where: `record_type='Current' AND sign_x_coord between ${Math.round(x - radiusFt)} and ${Math.round(x + radiusFt)} AND sign_y_coord between ${Math.round(y - radiusFt)} and ${Math.round(y + radiusFt)}`,
    $limit: "400",
  });
  const res = await fetch(`${SIGNS}?${params}`, { headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`signs ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({ ...r, x: +r.sign_x_coord, y: +r.sign_y_coord, dist: Math.hypot(+r.sign_x_coord - x, +r.sign_y_coord - y) }))
    .filter((r) => r.x && r.y).sort((a, b) => a.dist - b.dist);
}

const SIDES = { N: "north", S: "south", E: "east", W: "west" };
const tc = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

async function check(lat, lng, at = new Date()) {
  const signs = await signsNear(lat, lng);
  if (!signs.length) return { status: "unknown", headline: "No sign data for this spot", detail: "The city has no parking signs mapped within about 250 ft. Check the posted signs before you leave the car.", rules: [], signs: [] };
  // The block face of the closest sign is most likely the curb you're on
  const near = signs[0];
  const face = signs.filter((s) => s.on_street === near.on_street && s.side_of_street === near.side_of_street && s.from_street === near.from_street && s.to_street === near.to_street && s.dist < 400);
  const now = nyNow(at);
  const seen = new Set(), rules = [];
  for (const s of face) {
    const r = parseSign(s.sign_description);
    if (!r || seen.has(r.raw)) continue; seen.add(r.raw); rules.push(r);
  }
  const blocking = rules.filter((r) => r.kind !== "meter");
  const meters = rules.filter((r) => r.kind === "meter");
  let active = null, activeEnd = null, next = null;
  for (const r of blocking) {
    for (const w of schedule(r, now)) {
      if (w.start <= 0 && w.end > 0) { if (!active || w.end > activeEnd.end) { active = r; activeEnd = w; } }
      else if (w.start > 0 && (!next || w.start < next.w.start)) next = { r, w };
    }
  }
  const meterNow = meters.find((r) => schedule(r, now).some((w) => w.start <= 0 && w.end > 0));
  const where = `${tc(near.on_street)}, ${SIDES[near.side_of_street] || ""} side${near.from_street ? ` · ${tc(near.from_street)} to ${tc(near.to_street)}` : ""}`;
  let status, headline, detail, moveBy = null;
  if (active) {
    status = "red";
    headline = active.anytime ? `${active.label} anytime` : `${active.label} right now`;
    detail = active.anytime ? "You can't leave the car here." : `Until ${fmtWhen({ ...activeEnd, s: activeEnd.e, start: -1 }, now)}.`;
  } else if (meterNow) {
    status = "yellow";
    headline = `${meterNow.label} now`;
    detail = `Pay at the muni-meter or with the ParkNYC app.${next ? ` Then ${next.r.label.toLowerCase()} ${fmtWhen(next.w, now)}.` : ""}`;
    if (next) moveBy = new Date(at.getTime() + next.w.start * 60000).toISOString();
  } else {
    status = "green";
    if (next && next.w.start <= 7 * 1440) {
      headline = `You can park until ${fmtWhen(next.w, now)}`;
      detail = `${next.r.label} starts then.${next.w.start < 120 ? " That's soon." : ""}`;
      moveBy = new Date(at.getTime() + next.w.start * 60000).toISOString();
    } else { headline = "You can park here"; detail = "No restrictions found on this block's signs this week."; }
  }
  return {
    status, headline, detail, moveBy, where,
    rules: rules.map(describe),
    sweeping: rules.some((r) => r.sweeping),
    commercial: rules.some((r) => r.commercial),
    signs: face.slice(0, 12).map((s) => { const [la, ln] = toLatLng(s.x, s.y); return { lat: +la.toFixed(6), lng: +ln.toFixed(6), text: tc(parseSign(s.sign_description)?.raw || s.sign_description) }; }),
    checkedAt: at.toISOString(),
  };
}

// Calendar reminder (.ics): iPhone shows "Add to Calendar" and alerts 30 min before
function ics(url, res) {
  const t = new Date(url.searchParams.get("t") || ""), where = String(url.searchParams.get("w") || "your car").replace(/[\r\n,;]/g, " ").slice(0, 120);
  if (isNaN(t)) { res.writeHead(400); res.end("Bad time"); return; }
  const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Plate Check//EN", "BEGIN:VEVENT",
    `UID:${Date.now()}@platecheck`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(new Date(t - 15 * 60000))}`, `DTEND:${f(t)}`,
    "SUMMARY:Move your car", `DESCRIPTION:Parking rules start at this time on ${where}.`, `LOCATION:${where}`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Move your car", "END:VALARM",
    "BEGIN:VALARM", "TRIGGER:-PT5M", "ACTION:DISPLAY", "DESCRIPTION:Move your car now", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="move-your-car.ics"' });
  res.end(body);
}

function routes(url, res, sendJSON) {
  if (url.pathname === "/api/park/reminder.ics") { ics(url, res); return true; }
  if (url.pathname !== "/api/park") return false;
  const lat = +url.searchParams.get("lat"), lng = +url.searchParams.get("lng");
  if (!(lat > 40.4 && lat < 41) || !(lng > -74.3 && lng < -73.6)) { sendJSON(res, 400, { error: "That spot is outside New York City." }); return true; }
  check(lat, lng).then((r) => sendJSON(res, 200, r)).catch((e) => { console.error("park:", e.message); sendJSON(res, 502, { error: "Couldn't reach the city's sign data. Try again." }); });
  return true;
}

module.exports = { routes, parseSign, toStatePlane, toLatLng, check, schedule, nyNow, describe };
