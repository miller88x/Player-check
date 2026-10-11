// Ticket app — Step 1: plate ticket lookup
// Zero dependencies. Needs Node 18+ (built-in fetch). Deploys to Render as a Web Service.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || ""; // optional: higher NYC Open Data rate limits
const DATASET = "https://data.cityofnewyork.us/resource/nc67-uf89.json"; // Open Parking and Camera Violations

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

function toDate(mmddyyyy) {
  const [m, d, y] = String(mmddyyyy || "").split("/");
  return y ? new Date(Number(y), Number(m) - 1, Number(d)) : null;
}

function classify(t) {
  const due = num(t.amount_due);
  const fine = num(t.fine_amount);
  if (fine === null && due === null) return "expired"; // written off, blank financials
  if (due > 0 && (num(t.penalty_amount) > 0 || num(t.interest_amount) > 0)) return "penalty";
  if (due > 0) return "open";
  if (String(t.violation_status || "").includes("NOT GUILTY")) return "dismissed";
  return "closed";
}

async function lookup(plate, state) {
  const params = new URLSearchParams({ plate, state, $limit: "5000" });
  const res = await fetch(`${DATASET}?${params}`, {
    headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {},
  });
  if (!res.ok) throw new Error(`NYC Open Data returned ${res.status}`);
  const rows = await res.json();
  const now = Date.now();

  const tickets = rows
    .map((t) => {
      const issued = toDate(t.issue_date);
      const status = classify(t);
      const ageDays = issued ? Math.floor((now - issued) / 86400000) : null;
      return {
        summons: t.summons_number,
        issued: issued ? issued.toISOString().slice(0, 10) : null,
        time: t.violation_time || null,
        violation: t.violation || "Unknown violation",
        agency: t.issuing_agency || null,
        county: t.county || null,
        precinct: t.precinct || null,
        fine: num(t.fine_amount),
        penalty: num(t.penalty_amount),
        interest: num(t.interest_amount),
        reduction: num(t.reduction_amount),
        paid: num(t.payment_amount),
        due: num(t.amount_due),
        hearing: t.violation_status || null,
        image: t.summons_image?.url?.replace("http://", "https://") || null,
        ageDays,
        status,
        // NYC unpaid tickets typically go into judgment ~100 days after issue
        judgment: (status === "open" || status === "penalty") && ageDays !== null && ageDays >= 100,
      };
    })
    .sort((a, b) => String(b.issued).localeCompare(String(a.issued)));

  const open = tickets.filter((t) => t.status === "open" || t.status === "penalty");
  const totalDue = open.reduce((s, t) => s + (t.due || 0), 0);
  const judgmentDue = open.filter((t) => t.judgment).reduce((s, t) => s + (t.due || 0), 0);

  return {
    plate,
    state,
    checkedAt: new Date().toISOString(),
    summary: {
      count: tickets.length,
      openCount: open.length,
      totalDue: Math.round(totalDue * 100) / 100,
      penaltiesAdded: Math.round(open.reduce((s, t) => s + (t.penalty || 0) + (t.interest || 0), 0) * 100) / 100,
      judgmentDue: Math.round(judgmentDue * 100) / 100,
      // NYC can boot or tow at more than $350 in parking-ticket judgments
      bootRisk: judgmentDue > 350,
    },
    tickets,
  };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/tickets") {
      const plate = (url.searchParams.get("plate") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const state = (url.searchParams.get("state") || "NY").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (plate.length < 2 || plate.length > 8) return send(res, 400, { error: "Enter a plate with 2 to 8 letters or numbers." });
      try {
        return send(res, 200, await lookup(plate, state));
      } catch (e) {
        return send(res, 502, { error: "Couldn't reach NYC ticket records. Try again in a minute." });
      }
    }

    if (url.pathname === "/health") return send(res, 200, { ok: true });

    // Serve the app
    const file = path.join(__dirname, "index.html");
    fs.readFile(file, (err, html) => (err ? send(res, 500, "Missing index.html", "text/plain") : send(res, 200, html, "text/html; charset=utf-8")));
  })
  .listen(PORT, () => console.log(`Ticket app running on port ${PORT}`));
