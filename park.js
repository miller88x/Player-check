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

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONNAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function parseSign(desc) {
  const d = String(desc || "").toUpperCase().replace(/\(SUPERSEDES[^)]*\)/g, "").replace(/\s+/g, " ").trim();
  // Info plates, not rules (pay-by-cell number, Open Streets info, etc.)
  if (/LOCATOR|INFORMATION SIGN|\(INFO|^OPEN STREETS|^SEE OTHER SIDE/.test(d)) return null;
  let kind = null;
  if (/NO STOPPING/.test(d)) kind = "stop";
  else if (/NO STANDING/.test(d)) kind = "stand";
  else if (/NO PARKING/.test(d)) kind = "park";
  else if (/TRUCK LOADING ONLY|COMMERCIAL VEHICLES ONLY|LOADING ZONE|LOADING ONLY/.test(d)) kind = "truck";
  else if (/(\d+|ONE|TWO|THREE|1\/2)\s*(HOUR|HR|MIN|HMP|HMCP)\b/.test(d) || /METER|MUNI|\bHMP\b/.test(d)) kind = "meter";
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

  // Seasonal rules, e.g. "MAY-OCTOBER" or "NOV 1 - MAR 31"
  let months = null;
  const mr = d.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?(?:\s*\d{1,2})?\s*(?:-|THRU|THROUGH|TO)\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*/);
  if (mr) { months = []; let i = MONTHS.indexOf(mr[1]); const j = MONTHS.indexOf(mr[2]); for (let k = 0; k < 12; k++) { months.push(i); if (i === j) break; i = (i + 1) % 12; } }

  const sweeping = /BROOM|SANITATION/.test(d);
  const hrs = d.match(/(\d+|ONE|TWO|THREE)\s*(?:HOUR|HR|HMP|HMCP)\b/);
  const commercial = /COMMERCIAL|TRUCK|LOADING/.test(d) && kind !== "meter";
  const n = hrs && (hrs[1] === "ONE" ? 1 : hrs[1] === "TWO" ? 2 : hrs[1] === "THREE" ? 3 : hrs[1]);
  const label = {
    stop: "No stopping", stand: "No standing", park: sweeping ? "Street cleaning: no parking" : "No parking",
    truck: /COMMERCIAL VEHICLES ONLY/.test(d) ? "Commercial vehicles only" : "Truck loading only",
    meter: n ? `${n}-hour ${/HMP|HMCP|METER|MUNI/.test(d) ? "metered " : ""}parking` : "Metered parking",
  }[kind];
  const paid = kind === "meter" && (!n || /HMP|HMCP|METER|MUNI/.test(d));
  const raw = d.replace(/\s*<?-+>?\s*$/, "").replace(/<->|-->|<--/g, "").trim();
  // A meter sign with no hours printed doesn't say when it applies; don't invent "all day"
  if (kind === "meter" && !windows.length) return { kind, sweeping, commercial, anytime: false, days, months, windows: [], label, noHours: true, paid, hours: n, raw };
  return { kind, sweeping, commercial, anytime, days, months, windows: anytime ? [[0, 24 * 60]] : windows.length ? windows : [[0, 24 * 60]], label, paid, hours: n, raw };
}

// ---------- Is it in force now, and when next? ----------
// Alternate side parking (street cleaning) suspension days — NYC DOT 2026 calendar.
// Add the next year's list when the city publishes it (usually in December).
const ASP_SUSPENDED = {
  "2026-01-01": "New Year's Day", "2026-01-06": "Three Kings' Day", "2026-01-19": "Martin Luther King Jr. Day", "2026-02-12": "Lincoln's Birthday",
  "2026-02-16": "Presidents' Day", "2026-02-17": "Lunar New Year", "2026-02-18": "Ash Wednesday", "2026-03-03": "Purim",
  "2026-03-20": "Eid al-Fitr", "2026-03-21": "Eid al-Fitr", "2026-04-02": "Holy Thursday / Passover", "2026-04-03": "Good Friday / Passover",
  "2026-04-08": "Passover", "2026-04-09": "Passover / Orthodox Holy Thursday", "2026-04-10": "Orthodox Good Friday", "2026-05-14": "Solemnity of the Ascension",
  "2026-05-22": "Shavuot", "2026-05-23": "Shavuot", "2026-05-25": "Memorial Day", "2026-05-27": "Eid al-Adha", "2026-05-28": "Eid al-Adha",
  "2026-06-19": "Juneteenth", "2026-07-03": "Independence Day", "2026-07-04": "Independence Day", "2026-07-23": "Tisha B'Av",
  "2026-08-15": "Feast of the Assumption", "2026-09-07": "Labor Day", "2026-09-12": "Rosh Hashanah", "2026-09-13": "Rosh Hashanah",
  "2026-09-21": "Yom Kippur", "2026-09-26": "Sukkot", "2026-09-27": "Sukkot", "2026-10-03": "Shemini Atzeret", "2026-10-04": "Simchat Torah",
  "2026-10-12": "Italian Heritage / Indigenous Peoples' Day", "2026-11-01": "All Saints' Day", "2026-11-03": "Election Day", "2026-11-08": "Diwali",
  "2026-11-11": "Veterans Day", "2026-11-26": "Thanksgiving", "2026-12-08": "Immaculate Conception", "2026-12-25": "Christmas",
};
const nyDate = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

function nyNow(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const dates = Array.from({ length: 9 }, (_, k) => nyDate(new Date(at.getTime() + k * 864e5)));
  return { day: DAYS.indexOf(p.weekday.toUpperCase()), min: (+p.hour % 24) * 60 + +p.minute, dates };
}
// minutes from now until each start/end over the next 7 days
function schedule(rule, now) {
  const out = [];
  for (let k = 0; k <= 7; k++) {
    const day = (now.day + k) % 7;
    if (!rule.days.includes(day)) continue;
    if (rule.sweeping && now.dates && ASP_SUSPENDED[now.dates[k]]) continue; // street cleaning suspended that day
    if (rule.months && now.dates && !rule.months.includes(+now.dates[k].slice(5, 7) - 1)) continue; // out of season
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
  if (rule.noHours) return rule.label;
  const season = rule.months ? ` · ${MONNAME[rule.months[0]]}–${MONNAME[rule.months[rule.months.length - 1]]} only` : "";
  const days = rule.days.length === 7 ? "every day" : rule.days.length === 6 ? `except ${DAYNAME[DAYS[[0,1,2,3,4,5,6].find((x) => !rule.days.includes(x))]]}` :
    rule.days.join() === "1,2,3,4,5" ? "Mon–Fri" : rule.days.map((x) => DAYNAME[DAYS[x]]).join(", ");
  return `${rule.label} ${rule.windows.map(([s, e]) => `${fmtClock(s)}–${fmtClock(e)}`).join(", ")} · ${days}${season}`;
}

function suspensionNote(rules, now) {
  if (!rules.some((r) => r.sweeping)) return "";
  const today = ASP_SUSPENDED[now.dates[0]];
  if (today && rules.some((r) => r.sweeping && r.days.includes(now.day))) return ` Street cleaning is suspended today (${today}).`;
  const k = [1, 2, 3, 4, 5, 6].find((i) => ASP_SUSPENDED[now.dates[i]] && rules.some((r) => r.sweeping && r.days.includes((now.day + i) % 7)));
  return k ? ` Street cleaning is suspended ${k === 1 ? "tomorrow" : DAYNAME[DAYS[(now.day + k) % 7]]} (${ASP_SUSPENDED[now.dates[k]]}).` : "";
}

// Signs barely change, so cache them by 300 ft grid cell for 12 hours: repeat checks nearby are instant
// and the city's servers see far fewer requests. Each cell fetches its area plus a margin.
const CELL = 300, MARGIN = 300, cellCache = new Map(), cellBusy = new Map();
async function cellRows(cx, cy) {
  const key = `${cx}|${cy}`, hit = cellCache.get(key);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.rows;
  if (cellBusy.has(key)) return cellBusy.get(key);
  const x0 = cx * CELL - MARGIN, x1 = (cx + 1) * CELL + MARGIN, y0 = cy * CELL - MARGIN, y1 = (cy + 1) * CELL + MARGIN;
  const p = (async () => {
    const params = new URLSearchParams({
      $select: "on_street,from_street,to_street,side_of_street,sign_x_coord,sign_y_coord,sign_description,arrow_direction",
      $where: `record_type='Current' AND sign_x_coord between ${x0} and ${x1} AND sign_y_coord between ${y0} and ${y1}`,
      $limit: "5000",
    });
    const res = await fetch(`${SIGNS}?${params}`, { headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`signs ${res.status}`);
    const rows = (await res.json()).map((r) => ({ ...r, x: +r.sign_x_coord, y: +r.sign_y_coord })).filter((r) => r.x && r.y);
    cellCache.set(key, { at: Date.now(), rows });
    if (cellCache.size > 4000) cellCache.delete(cellCache.keys().next().value);
    return rows;
  })().finally(() => cellBusy.delete(key));
  cellBusy.set(key, p);
  return p;
}
async function signsNear(lat, lng, radiusFt = 260) {
  const [x, y] = toStatePlane(lat, lng);
  const rows = await cellRows(Math.floor(x / CELL), Math.floor(y / CELL));
  return rows.map((r) => ({ ...r, dist: Math.hypot(r.x - x, r.y - y) }))
    .filter((r) => Math.abs(r.x - x) <= radiusFt && Math.abs(r.y - y) <= radiusFt).sort((a, b) => a.dist - b.dist);
}

const SIDES = { N: "north", S: "south", E: "east", W: "west" };
const tc = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// Signs sit along one curb. Project them onto the block's line; an arrow (-->) means the rule runs from that
// sign in the arrow's direction until a sign of the same rule pointing back, or the end of the block.
// "<->" (no arrow) means the sign is in the middle of its stretch.
const COMPASS = { EAST: [1, 0], WEST: [-1, 0], NORTH: [0, 1], SOUTH: [0, -1], E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };
function curbZones(face, px, py) {
  let ux = 1, uy = 0, best = 0; // block direction = the two signs farthest apart
  for (const a of face) for (const b of face) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (d > best) { best = d; ux = (b.x - a.x) / d; uy = (b.y - a.y) / d; } }
  const pos = (x, y) => x * ux + y * uy;
  const ps = face.map((s) => pos(s.x, s.y)), lo = Math.min(...ps) - 40, hi = Math.max(...ps) + 40;
  const me = Math.max(lo, Math.min(hi, pos(px, py)));
  const groups = new Map();
  for (const s of face) {
    const r = parseSign(s.sign_description); if (!r) continue;
    const v = COMPASS[String(s.arrow_direction || "").toUpperCase()];
    const dir = v ? Math.sign(v[0] * ux + v[1] * uy) : 0;
    if (!groups.has(r.raw)) groups.set(r.raw, { rule: r, signs: [] });
    groups.get(r.raw).signs.push({ p: pos(s.x, s.y), dir });
  }
  const out = [];
  for (const { rule, signs } of groups.values()) {
    const iv = signs.map((g) => {
      const back = (side) => signs.filter((o) => (side > 0 ? o.p > g.p + 5 && o.dir === -1 : o.p < g.p - 5 && o.dir === 1)).map((o) => o.p);
      const L = back(-1), R = back(1);
      if (g.dir === 1) return [g.p, R.length ? Math.min(...R) : hi];
      if (g.dir === -1) return [L.length ? Math.max(...L) : lo, g.p];
      return [L.length ? Math.max(...L) : lo, R.length ? Math.min(...R) : hi];
    });
    const here = iv.some(([a, b]) => me >= a - 8 && me <= b + 8);
    const edge = Math.min(...iv.map(([a, b]) => (me >= a && me <= b ? 0 : Math.min(Math.abs(me - a), Math.abs(me - b)))));
    out.push({ rule, here, edge, iv });
  }
  return out;
}

async function check(lat, lng, at = new Date()) {
  const signs = await signsNear(lat, lng);
  if (!signs.length) return { status: "unknown", headline: "No sign data for this spot", detail: "The city has no parking signs mapped within about 250 ft. Check the posted signs before you leave the car.", rules: [], signs: [] };
  // The block face of the closest sign is most likely the curb you're on
  const near = signs[0];
  const face = signs.filter((s) => s.on_street === near.on_street && s.side_of_street === near.side_of_street && s.from_street === near.from_street && s.to_street === near.to_street && s.dist < 400);
  const now = nyNow(at);
  // Which part of the curb is the car on? Each rule covers stretches marked by its sign arrows.
  const [px, py] = toStatePlane(lat, lng);
  const zones = curbZones(face, px, py);
  const rules = zones.filter((z) => z.here).map((z) => z.rule), elsewhere = zones.filter((z) => !z.here).map((z) => z.rule);
  const nearZone = zones.some((z) => !z.here && z.edge < 25 && z.rule.kind !== "meter");
  const blocking = rules.filter((r) => r.kind !== "meter");
  const meters = rules.filter((r) => r.kind === "meter" && !r.noHours);
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
    detail = active.anytime ? "You can't leave the car here." : `Until ${fmtWhen({ ...activeEnd, s: activeEnd.e, start: -1 }, now)}.${active.kind === "truck" ? " Only commercial vehicles loading or unloading." : ""}`;
  } else if (meterNow) {
    status = "yellow";
    headline = `${meterNow.label} now`;
    detail = `${meterNow.paid ? "Pay at the muni-meter or with the ParkNYC app." : `${meterNow.hours}-hour limit.`}${next ? ` Then ${next.r.label.toLowerCase()} ${fmtWhen(next.w, now)}.` : ""}`;
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
    status, headline, detail: detail + suspensionNote(rules, now) + (nearZone && status !== "red" ? " You're near the edge of a no-parking stretch, so check which way the sign arrows point." : ""), moveBy, where,
    suspendedToday: rules.some((r) => r.sweeping) ? ASP_SUSPENDED[now.dates[0]] || null : null,
    // Meter in force now: how long you may pay for (sign's hour limit, and when the meter hours end)
    meter: meterNow ? (() => { const w = schedule(meterNow, now).find((x) => x.start <= 0 && x.end > 0); return { paid: !!meterNow.paid, hours: +meterNow.hours || null, minsLeft: w ? w.end : null, nextRuleMins: next ? next.w.start : null }; })() : null,
    rules: rules.map(describe),
    rulesElse: elsewhere.map(describe),
    sweeping: rules.some((r) => r.sweeping),
    commercial: rules.some((r) => r.commercial),
    signs: face.slice(0, 12).map((s) => { const [la, ln] = toLatLng(s.x, s.y); return { lat: +la.toFixed(6), lng: +ln.toFixed(6), text: tc(parseSign(s.sign_description)?.raw || s.sign_description) }; }),
    checkedAt: at.toISOString(),
  };
}

// Calendar reminder (.ics): iPhone shows "Add to Calendar" and alerts 30 min before
function ics(url, res) {
  const t = new Date(url.searchParams.get("t") || ""), where = String(url.searchParams.get("w") || "your car").replace(/[\r\n,;]/g, " ").slice(0, 120);
  const clean = (v, n) => String(v || "").replace(/[\r\n,;\\]/g, " ").slice(0, n);
  const title = clean(url.searchParams.get("s"), 80) || "Move your car", desc = clean(url.searchParams.get("d"), 200) || `Parking rules start at this time on ${where}.`;
  const allDay = url.searchParams.get("allday") === "1";
  if (isNaN(t)) { res.writeHead(400); res.end("Bad time"); return; }
  const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Rova//EN", "BEGIN:VEVENT",
    `UID:${Date.now()}@rova`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(new Date(t - 15 * 60000))}`, `DTEND:${f(t)}`,
    `SUMMARY:${title}`, `DESCRIPTION:${desc}`, ...(allDay ? [] : [`LOCATION:${where}`]),
    "BEGIN:VALARM", allDay ? "TRIGGER:-P1D" : "TRIGGER:-PT30M", "ACTION:DISPLAY", `DESCRIPTION:${title}`, "END:VALARM",
    "BEGIN:VALARM", allDay ? "TRIGGER:PT0M" : "TRIGGER:-PT5M", "ACTION:DISPLAY", `DESCRIPTION:${title}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="rova-reminder.ics"' });
  res.end(body);
}

// ---------- Colored curbs for the map ----------
// Every block face in view, split into stretches by its sign arrows, colored by what applies right now:
// green = park, yellow = metered / time limit, red = no parking / standing / stopping now.
// Signs fetched in 1,500 ft tiles (+200 ft margin so faces on tile edges are whole), cached 12 hours.
const TILE = 1500, TMARGIN = 200, tileCache = new Map(), tileBusy = new Map();
async function tileRows(tx, ty) {
  const key = `${tx}|${ty}`, hit = tileCache.get(key);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.rows;
  if (tileBusy.has(key)) return tileBusy.get(key);
  const x0 = tx * TILE - TMARGIN, x1 = (tx + 1) * TILE + TMARGIN, y0 = ty * TILE - TMARGIN, y1 = (ty + 1) * TILE + TMARGIN;
  const p = (async () => {
    const params = new URLSearchParams({
      $select: "on_street,from_street,to_street,side_of_street,sign_x_coord,sign_y_coord,sign_description,arrow_direction",
      $where: `record_type='Current' AND sign_x_coord between ${x0} and ${x1} AND sign_y_coord between ${y0} and ${y1}`,
      $limit: "20000",
    });
    const res = await fetch(`${SIGNS}?${params}`, { headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {}, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`signs ${res.status}`);
    const rows = (await res.json()).map((r) => ({ ...r, x: +r.sign_x_coord, y: +r.sign_y_coord })).filter((r) => r.x && r.y);
    tileCache.set(key, { at: Date.now(), rows });
    if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
    return rows;
  })().finally(() => tileBusy.delete(key));
  tileBusy.set(key, p);
  return p;
}

function stateNow(rules, now) {
  let red = null, yellow = null, next = null;
  for (const r of rules) {
    if (r.noHours) continue;
    for (const w of schedule(r, now)) {
      if (w.start <= 0 && w.end > 0) { if (r.kind === "meter") yellow = yellow || r; else red = red || r; }
      else if (w.start > 0 && r.kind !== "meter" && (!next || w.start < next.start)) next = { r, start: w.start, w };
    }
  }
  if (red) return { s: "red", why: red.anytime ? `${red.label} anytime` : `${red.label} now` };
  if (yellow) return { s: "yellow", why: `${yellow.label} now` };
  return { s: "green", why: next && next.start <= 7 * 1440 ? `Park until ${fmtWhen(next.w, now)}` : "No rules on the signs right now" };
}

async function curbs(w, s, e, n, at = new Date()) {
  const [x0, y0] = toStatePlane(s, w), [x1, y1] = toStatePlane(n, e);
  const tx0 = Math.floor(Math.min(x0, x1) / TILE), tx1 = Math.floor(Math.max(x0, x1) / TILE);
  const ty0 = Math.floor(Math.min(y0, y1) / TILE), ty1 = Math.floor(Math.max(y0, y1) / TILE);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 12) return { type: "FeatureCollection", features: [], tooBig: true };
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) jobs.push(tileRows(tx, ty));
  const seen = new Set(), faces = new Map();
  for (const rows of await Promise.all(jobs)) for (const r of rows) {
    const k = `${r.on_street}|${r.side_of_street}|${r.from_street}|${r.to_street}|${r.x}|${r.y}|${r.sign_description}`;
    if (seen.has(k)) continue; seen.add(k);
    const f = `${r.on_street}|${r.side_of_street}|${r.from_street}|${r.to_street}`;
    if (!faces.has(f)) faces.set(f, []);
    faces.get(f).push(r);
  }
  const now = nyNow(at), feats = [];
  const pad = 600, minX = Math.min(x0, x1) - pad, maxX = Math.max(x0, x1) + pad, minY = Math.min(y0, y1) - pad, maxY = Math.max(y0, y1) + pad;
  for (const face of faces.values()) {
    if (face.length < 2) continue;
    if (!face.some((r) => r.x > minX && r.x < maxX && r.y > minY && r.y < maxY)) continue;
    // Block direction from the two signs farthest apart; skip faces that are really two different blocks
    let ux = 1, uy = 0, best = 0;
    for (const a of face) for (const b of face) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (d > best) { best = d; ux = (b.x - a.x) / d; uy = (b.y - a.y) / d; } }
    if (best < 40 || best > 1400) continue;
    const zones = curbZones(face, face[0].x, face[0].y);
    if (!zones.length) continue;
    const ps = face.map((r) => r.x * ux + r.y * uy), lo = Math.min(...ps), hi = Math.max(...ps);
    const q = face.reduce((t, r) => t + (r.x * -uy + r.y * ux), 0) / face.length; // distance across: keeps each side of the street on its own curb
    const cuts = [...new Set([lo, hi, ...zones.flatMap((z) => z.iv.flat()).filter((p) => p > lo && p < hi)])].sort((a, b) => a - b);
    const pt = (p) => { const [la, ln] = toLatLng(p * ux + q * -uy, p * uy + q * ux); return [+ln.toFixed(6), +la.toFixed(6)]; };
    let run = null; const mine = [];
    const flush = () => { if (run && run.b - run.a > 8) mine.push({ type: "Feature", properties: { s: run.s, why: run.why, st: tc(face[0].on_street) }, geometry: { type: "LineString", coordinates: [pt(run.a), pt(run.b)] } }); };
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1], m = (a + b) / 2;
      const rules = zones.filter((z) => z.iv.some(([p0, p1]) => m >= p0 - 1 && m <= p1 + 1)).map((z) => z.rule);
      const st = stateNow(rules, now);
      if (run && run.s === st.s && run.why === st.why) run.b = b;
      else { flush(); run = { a, b, ...st }; }
    }
    flush();
    // The rule at each end of the block runs on to the corner: the app stretches these two to the cross streets
    if (mine.length) { mine[0].properties.first = 1; mine[mine.length - 1].properties.last = 1; feats.push(...mine); }
  }
  return { type: "FeatureCollection", features: feats, at: at.toISOString() };
}

function routes(url, res, sendJSON) {
  if (url.pathname === "/api/park/reminder.ics") { ics(url, res); return true; }
  if (url.pathname === "/api/park/curbs") {
    const [w, s, e, n] = ["w", "s", "e", "n"].map((k) => +url.searchParams.get(k));
    if (![w, s, e, n].every(Number.isFinite) || s < 40.4 || n > 41 || w < -74.3 || e > -73.6 || (e - w) * (n - s) > 0.0004) { sendJSON(res, 200, { type: "FeatureCollection", features: [] }); return true; }
    curbs(w, s, e, n).then((fc) => sendJSON(res, 200, fc)).catch((err) => { console.error("curbs:", err.message); sendJSON(res, 502, { error: "Couldn't reach the city's sign data." }); });
    return true;
  }
  if (url.pathname !== "/api/park") return false;
  const lat = +url.searchParams.get("lat"), lng = +url.searchParams.get("lng");
  if (!(lat > 40.4 && lat < 41) || !(lng > -74.3 && lng < -73.6)) { sendJSON(res, 400, { error: "Parking sign checks cover New York City for now. More cities are coming." }); return true; }
  check(lat, lng).then((r) => sendJSON(res, 200, r)).catch((e) => { console.error("park:", e.message); sendJSON(res, 502, { error: "Couldn't reach the city's sign data. Try again." }); });
  return true;
}

module.exports = { ASP_SUSPENDED, routes, curbs, parseSign, curbZones, toStatePlane, toLatLng, check, schedule, nyNow, describe };
