// Step 4: dispute letters.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise builds a solid letter from a template.
// The letter never invents facts: anything the driver must fill in is left in [brackets].

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.DISPUTE_MODEL || "claude-haiku-5-5";

const isCamera = (v) => /PHTO|CAMERA|BUS LANE|RED LIGHT|SPEED/i.test(v || "");

// Reasons NYC actually considers (from DOF's dispute guidance)
const REASONS = {
  parking: {
    sign: { label: "Sign was missing, blocked or unclear", evidence: ["Date-stamped photos of the whole block, showing the front and back of every sign", "A photo showing the address where you parked"] },
    defect: { label: "Ticket has wrong or missing info", evidence: ["A photo of your registration showing the correct plate, state and make", "A photo of the ticket showing the wrong or missing detail"] },
    meter: { label: "Meter or muni-meter was broken", evidence: ["Photo of the broken meter with its number", "Any 311 complaint number you filed"] },
    paid: { label: "I paid / had a valid receipt or permit", evidence: ["Copy of the parking receipt, app payment or permit", "Photo showing it displayed in the car, if you have one"] },
    hydrant: { label: "I was more than 15 ft from the hydrant", evidence: ["Photos showing the distance from the hydrant to your car's position", "A measurement (tape or measuring app) if you have one"] },
    notme: { label: "My car wasn't there at that time", evidence: ["Proof of where the car was (receipts, toll records, garage ticket)", "Any witness statement"] },
    loading: { label: "I was actively loading or unloading", evidence: ["Delivery receipts or invoices with times", "Business documents showing the stop was for work"] },
    other: { label: "Something else", evidence: ["Any photos, receipts or documents that support what you're saying"] },
  },
  camera: {
    notmine: { label: "Not my car / wrong plate read", evidence: ["Photo of your registration and plate", "The camera photos from the ticket website, showing the car doesn't match"] },
    stolen: { label: "Car was reported stolen before the date", evidence: ["Police report showing the theft was reported before the violation", "Report number and date"] },
    malfunction: { label: "Camera malfunctioned", evidence: ["The camera photos/video from the ticket website", "Anything showing the reading was wrong"] },
    sold: { label: "I sold or transferred the car before the date", evidence: ["Bill of sale or transfer paperwork with the date", "DMV plate surrender receipt"] },
    hours: { label: "Issued outside enforcement hours (before Aug 1, 2022)", evidence: ["The ticket showing the date and time"] },
    other: { label: "Something else", evidence: ["Any documents that support what you're saying"] },
  },
};

function reasonsFor(violation) {
  const set = isCamera(violation) ? REASONS.camera : REASONS.parking;
  return Object.entries(set).map(([key, r]) => ({ key, label: r.label }));
}

// "1025P" -> "10:25 PM"
const fmtTime = (s) => { const m = String(s || "").match(/^(\d{1,2}):?(\d{2})\s*([AP])/i); return m ? `${+m[1] || 12}:${m[2]} ${m[3].toUpperCase()}M` : s; };
const clean = (s, n = 600) => String(s || "").replace(/[\u0000-\u001f]+/g, " ").slice(0, n).trim();

function templateLetter(t, r, details, name) {
  const who = name || "[Your full name]";
  const when = t.issued ? new Date(t.issued + "T12:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "[date]";
  const where = t.address ? `at ${t.address}` : "at [location on the ticket]";
  const opening = `I am writing to dispute summons number ${t.summons}, issued on ${when}${t.time ? ` at ${t.time}` : ""} ${where} for "${t.violation}" on plate ${t.plate} (${t.state}). I am requesting that this summons be dismissed.`;
  const body = {
    sign: `The posted signage at this location did not give clear notice of the restriction. [Describe exactly what the signs said, where they were, and what was missing, blocked or confusing.] The attached date-stamped photos show the full block, including the front and back of each sign.`,
    defect: `The summons is defective because a required element is missing or described incorrectly. [State which detail is wrong — for example the plate, state, vehicle make, date, time or location — and what the correct information is.] Under the Department of Finance's rules, a summons with a missing, illegible or misdescribed required element may be dismissed.`,
    meter: `The parking meter at this location was not working at the time. [Give the meter number, what you saw on the display, and whether you reported it to 311.]`,
    paid: `I had paid for parking / held a valid permit for this location and time. [Describe the payment or permit, the time it covered, and how it was displayed.] A copy is attached.`,
    hydrant: `My vehicle was parked more than 15 feet from the fire hydrant. [Give the distance you measured and how you measured it.] The summons [does / does not] state the distance in feet from the hydrant, which is a required element for this violation.`,
    notme: `My vehicle was not at this location at the time stated on the summons. [Explain where the vehicle was and how you know.] Supporting records are attached.`,
    loading: `At the time of the summons I was actively loading or unloading [describe the goods and the business purpose]. [Explain how long the stop lasted.] Supporting delivery records are attached.`,
    notmine: `The vehicle in the camera images is not my vehicle. [Explain the difference — for example, a different make, color, or a misread plate.] A copy of my registration is attached for comparison.`,
    stolen: `My vehicle was reported stolen before the date of this violation and had not been recovered. The police report number is [report number], filed on [date]. A copy is attached.`,
    malfunction: `I believe the camera was not working correctly at the time of this violation. [Explain what in the camera images or the circumstances shows the reading was wrong.]`,
    sold: `I was not the owner of this vehicle on the date of the violation. I sold / transferred it on [date] to [buyer]. The paperwork is attached.`,
    hours: `This violation was issued outside the camera's enforcement hours in effect at the time. [Give the date, time and the hours that applied.]`,
    other: `[Explain clearly why this summons should be dismissed.]`,
  }[r] || "";
  const extra = details ? `\n\nAdditional details: ${details}` : "";
  return `To the Administrative Law Judge,\n\n${opening}\n\n${body}${extra}\n\nI respectfully ask that this summons be dismissed. Thank you for your consideration.\n\nSincerely,\n${who}\nPlate: ${t.plate} (${t.state})\nSummons: ${t.summons}`;
}

async function aiLetter(t, reasonLabel, details, name) {
  const system = `You write dispute statements for New York City parking and camera tickets, addressed to a Department of Finance administrative law judge.
Rules:
- Use only facts the driver provided or that appear in the ticket data. Never invent facts, measurements, times, receipts, witnesses or report numbers.
- Where a fact is needed but not given, leave a short placeholder in square brackets, e.g. [meter number].
- Be respectful, specific and short: 150-260 words, plain sentences, no legal jargon beyond what DOF uses.
- Ground the argument in the chosen reason. Defenses DOF recognizes include: unclear or missing signs (with photos of the whole block, front and back of signs), defective tickets (missing, illegible or misdescribed required elements), fire hydrant tickets must state distance in feet (15 ft rule), broken meters, valid payment or permits; for school-zone speed cameras: not the owner / wrong vehicle, camera malfunction, vehicle reported stolen before the violation, or issued outside enforceable hours (only for violations before Aug 1, 2022).
- End by asking that the summons be dismissed, then sign with the name given or [Your full name], plate and summons number.
Return only the letter text.`;
  const user = `Ticket data:
- Summons: ${t.summons}
- Violation: ${t.violation}
- Issued: ${t.issued}${t.time ? " at " + t.time : ""}
- Location: ${t.address || "not listed"}
- Plate: ${t.plate} (${t.state})
- Amount: ${t.fine ?? "unknown"}
Reason chosen by the driver: ${reasonLabel}
Driver's own details: ${details || "(none given)"}
Driver's name: ${name || "(not given)"}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `AI ${res.status}`);
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}

// Light abuse guard: 30 AI letters per visitor per day
const usage = new Map();
function allowed(ip) {
  const day = new Date().toISOString().slice(0, 10), k = `${ip}|${day}`;
  const n = (usage.get(k) || 0) + 1; usage.set(k, n);
  if (usage.size > 5000) usage.clear();
  return n <= 30;
}

async function draft(body, ip) {
  const t = {
    summons: clean(body.summons, 20).replace(/\D/g, ""), violation: clean(body.violation, 80), issued: clean(body.issued, 10),
    time: fmtTime(clean(body.time, 10)), address: clean(body.address, 120), plate: clean(body.plate, 8).toUpperCase(), state: clean(body.state, 2).toUpperCase(),
    fine: body.fine != null ? Number(body.fine) : null,
  };
  if (!t.summons) throw new Error("Missing ticket number.");
  const camera = isCamera(t.violation);
  const set = camera ? REASONS.camera : REASONS.parking;
  const r = set[body.reason] ? body.reason : "other";
  const details = clean(body.details, 800), name = clean(body.name, 60);
  let letter, by = "template";
  if (API_KEY && allowed(ip)) {
    try { letter = await aiLetter(t, set[r].label, details, name); by = "ai"; } catch (e) { console.error("dispute ai:", e.message); }
  }
  if (!letter) letter = templateLetter(t, r, details, name);
  const judgmentDay = camera ? 75 : 100;
  return {
    letter, by, evidence: set[r].evidence,
    deadline: "Dispute within 30 days of the issue date to avoid late penalties.",
    judgmentDay, camera,
    submitUrl: "https://www.nyc.gov/site/finance/vehicles/dispute-web.page",
  };
}

function routes(url, res, sendJSON, readBody, req) {
  if (url.pathname === "/api/dispute/reasons") {
    return sendJSON(res, 200, { reasons: reasonsFor(url.searchParams.get("violation")), ai: !!API_KEY }), true;
  }
  if (url.pathname === "/api/dispute" && req.method === "POST") {
    readBody(req).then(async (b) => {
      try { sendJSON(res, 200, await draft(b, req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")); }
      catch (e) { sendJSON(res, 400, { error: e.message || "Couldn't write the letter." }); }
    }).catch(() => sendJSON(res, 400, { error: "Bad request" }));
    return true;
  }
  return false;
}

module.exports = { routes, templateLetter, reasonsFor, isCamera };
