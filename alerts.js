// Step 3: daily ticket alerts by email.
// Plates people subscribe to are stored in Supabase (table plate_alerts).
// Once a day Supabase calls /api/alerts/run, we re-check every plate and email anything new.
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const RUN_KEY = process.env.ALERTS_KEY || "";
const APP_URL = process.env.APP_URL || "https://player-check.onrender.com";
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

let lookup = null; // set by server.js
const status = { lastRun: null, lastResult: null, running: false };

const ready = () => ({
  supabase: !!(SB_URL && SB_KEY),
  email: !!(GMAIL_USER && GMAIL_PASS),
  runKey: !!RUN_KEY,
});

// ---------- Supabase (plain REST, no extra packages) ----------
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- Email (Gmail SMTP through nodemailer) ----------
let transport = null;
function mailer() {
  if (!transport) {
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  }
  return transport;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const title = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

function emailHTML(sub, heading, items, summary) {
  const rows = items.map((it) => `
    <tr><td style="padding:12px 0;border-top:1px solid #e5e7eb">
      <div style="font-weight:600;color:${it.color || "#111"}">${esc(it.title)}</div>
      <div style="color:#555;font-size:14px;margin-top:2px">${esc(it.detail)}</div>
    </td></tr>`).join("");
  const unsub = `${APP_URL}/api/alerts/off?id=${sub.id}&t=${sub.token}`;
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px;color:#111">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#888">Plate Check · ${esc(sub.plate)} (${esc(sub.state)})</div>
    <h2 style="margin:6px 0 4px;font-size:22px">${esc(heading)}</h2>
    ${summary ? `<div style="color:#444;margin-bottom:8px">${esc(summary)}</div>` : ""}
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="margin:18px 0">
      <a href="${APP_URL}" style="background:#1a73e8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:20px;font-weight:600">Open Plate Check</a>
      &nbsp; <a href="https://a836-citypay.nyc.gov/citypay/Parking" style="color:#1a73e8">Pay a ticket</a>
      &nbsp; <a href="https://www.nyc.gov/site/finance/vehicles/dispute-a-ticket.page" style="color:#1a73e8">Dispute</a>
    </div>
    <div style="color:#999;font-size:12px">Dates for penalties and judgment are estimates based on the ticket's issue date. Always confirm on the city's site.
    <br><a href="${unsub}" style="color:#999">Turn off alerts for this plate</a></div></div>`;
}
async function send(sub, subject, heading, items, summary) {
  await mailer().sendMail({
    from: `"Plate Check" <${GMAIL_USER}>`, to: sub.email, subject,
    html: emailHTML(sub, heading, items, summary),
    text: [heading, summary, ...items.map((i) => `- ${i.title}: ${i.detail}`), "", APP_URL].filter(Boolean).join("\n"),
  });
}

// ---------- What to warn about ----------
// NYC late penalties build up roughly 30, 60 and 90 days after a ticket is issued,
// and an unpaid ticket usually goes into judgment around day 100.
const STEPS = [
  { key: "p30", from: 23, to: 30, msg: (d) => `Late penalty in about ${d} day${d === 1 ? "" : "s"}` },
  { key: "p60", from: 53, to: 60, msg: (d) => `Another late penalty in about ${d} day${d === 1 ? "" : "s"}` },
  { key: "p90", from: 83, to: 90, msg: (d) => `Third late penalty in about ${d} day${d === 1 ? "" : "s"}` },
  { key: "j100", from: 93, to: 100, msg: (d) => `Goes into judgment in about ${d} day${d === 1 ? "" : "s"}` },
];
const isOpen = (t) => t.status === "open" || t.status === "penalty";

function findAlerts(sub, data) {
  const known = sub.known || {}, sent = sub.sent || {};
  const items = [];
  const newKnown = {}, newSent = { ...sent };
  for (const t of data.tickets) {
    newKnown[t.summons] = t.status;
    const date = t.issued ? new Date(t.issued + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    const what = `${title(t.violation)} · ${date}${t.location ? " · " + title(t.location.address) : ""}`;
    if (!(t.summons in known)) {
      if (isOpen(t)) items.push({ kind: "new", title: `New ticket: ${money(t.due ?? t.fine)}`, detail: what, color: "#c5221f" });
      continue; // a brand-new ticket gets one email, not a stack of them
    }
    if (!isOpen(t) || t.ageDays == null) continue;
    for (const s of STEPS) {
      const k = `${t.summons}:${s.key}`;
      if (t.ageDays >= s.from && t.ageDays < s.to && !sent[k]) {
        items.push({ kind: s.key, title: `${s.msg(s.to - t.ageDays)}: ${money(t.due)}`, detail: what, color: s.key === "j100" ? "#c5221f" : "#b06000" });
        newSent[k] = new Date().toISOString();
      }
    }
    const jk = `${t.summons}:judgment`;
    if (t.judgment && !sent[jk]) {
      items.push({ kind: "judgment", title: `Likely in judgment now: ${money(t.due)}`, detail: what, color: "#c5221f" });
      newSent[jk] = new Date().toISOString();
    }
  }
  const s = data.summary;
  if (s.bootRisk && !sent.boot) {
    items.unshift({ kind: "boot", title: `Boot / tow risk: ${money(s.judgmentDue)} in judgment`, detail: "NYC can boot or tow a car with more than $350 in parking ticket judgments. Pay or dispute these first.", color: "#c5221f" });
    newSent.boot = new Date().toISOString();
  }
  if (!s.bootRisk) delete newSent.boot; // warn again if it comes back later
  return { items, newKnown, newSent };
}

// ---------- Actions ----------
async function subscribe({ plate, state, email }) {
  if (!ready().supabase || !ready().email) throw new Error("Alerts aren't set up on the server yet.");
  const data = await lookup(plate, state, { locations: false });
  const known = Object.fromEntries(data.tickets.map((t) => [t.summons, t.status]));
  const token = crypto.randomBytes(16).toString("hex");
  const [sub] = await sb("plate_alerts?on_conflict=plate,state,email", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ plate, state, email, token, known, sent: {}, active: true, last_run: new Date().toISOString() }),
  });
  const s = data.summary;
  const open = data.tickets.filter(isOpen);
  await send(sub, `Alerts are on for ${plate}`, `You'll get an email if anything changes`,
    open.length ? open.slice(0, 10).map((t) => ({ title: `${money(t.due)} · ${title(t.violation)}`, detail: `Issued ${t.issued} · ${t.ageDays} days ago`, color: t.status === "penalty" ? "#c5221f" : "#b06000" }))
                : [{ title: "Nothing owed right now", detail: "We'll email you the day a new ticket shows up in city records.", color: "#188038" }],
    open.length ? `${open.length} open ticket${open.length === 1 ? "" : "s"}, ${money(s.totalDue)} owed. We check every morning for new tickets, upcoming penalties, judgment and boot risk.` : "We check every morning for new tickets, upcoming penalties, judgment and boot risk.");
  return { ok: true, openCount: open.length };
}

async function unsubscribe(id, token) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{32}$/.test(token)) return false;
  const rows = await sb(`plate_alerts?id=eq.${id}&token=eq.${token}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ active: false }) });
  return rows?.length > 0;
}

async function runAll() {
  if (status.running) return status.lastResult;
  status.running = true;
  const result = { checked: 0, emailed: 0, errors: [] };
  try {
    const subs = await sb("plate_alerts?active=eq.true&select=*");
    // Check each plate once even if several emails follow it
    const plates = new Map();
    for (const s of subs) {
      const k = `${s.plate}|${s.state}`;
      if (!plates.has(k)) {
        try { plates.set(k, await lookup(s.plate, s.state, { locations: true })); }
        catch (e) { plates.set(k, null); result.errors.push(`${k}: ${e.message}`); }
      }
      const data = plates.get(k);
      if (!data) continue;
      result.checked++;
      const { items, newKnown, newSent } = findAlerts(s, data);
      try {
        if (items.length) {
          const first = items[0];
          const subject = items.length === 1 ? `${s.plate}: ${first.title}` : `${s.plate}: ${items.length} ticket alerts`;
          await send(s, subject, items.some((i) => i.kind === "new") ? "New ticket activity" : "Heads up on your tickets", items,
            `${data.summary.openCount} open · ${money(data.summary.totalDue)} owed`);
          result.emailed++;
        }
        await sb(`plate_alerts?id=eq.${s.id}`, { method: "PATCH", body: JSON.stringify({ known: newKnown, sent: newSent, last_run: new Date().toISOString() }) });
      } catch (e) { result.errors.push(`${s.plate}: ${e.message}`); }
    }
  } catch (e) { result.errors.push(e.message); }
  status.running = false; status.lastRun = new Date().toISOString(); status.lastResult = result;
  return result;
}

function routes(url, res, sendJSON, readBody, req) {
  const p = url.pathname;
  if (p === "/api/alerts/status") return sendJSON(res, 200, { ready: ready(), lastRun: status.lastRun, lastResult: status.lastResult, running: status.running }), true;
  if (p === "/api/alerts/run") {
    if (!RUN_KEY || url.searchParams.get("key") !== RUN_KEY) return sendJSON(res, 403, { error: "Wrong key" }), true;
    runAll(); // runs in the background; check /api/alerts/status for the result
    return sendJSON(res, 200, { started: true }), true;
  }
  if (p === "/api/alerts/off") {
    unsubscribe(url.searchParams.get("id") || "", url.searchParams.get("t") || "")
      .then((ok) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<meta name=viewport content="width=device-width"><div style="font-family:-apple-system,Arial;padding:40px;text-align:center"><h2>${ok ? "Alerts turned off" : "That link didn't work"}</h2><p>${ok ? "You won't get more emails for this plate." : "It may already be off."}</p><a href="${APP_URL}">Open Plate Check</a></div>`); })
      .catch(() => sendJSON(res, 500, { error: "Try again later." }));
    return true;
  }
  if (p === "/api/alerts/subscribe" && req.method === "POST") {
    readBody(req).then(async (b) => {
      const plate = String(b.plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const state = String(b.state || "NY").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2);
      const email = String(b.email || "").trim().toLowerCase();
      if (plate.length < 2 || plate.length > 8) return sendJSON(res, 400, { error: "Enter a valid plate." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: "Enter a valid email address." });
      try { sendJSON(res, 200, await subscribe({ plate, state, email })); }
      catch (e) { sendJSON(res, 500, { error: /set up/.test(e.message) ? e.message : "Couldn't turn on alerts. Check the email address and try again." }); console.error(e); }
    }).catch(() => sendJSON(res, 400, { error: "Bad request" }));
    return true;
  }
  return false;
}

module.exports = { init: (fn) => (lookup = fn), routes, findAlerts, ready };
