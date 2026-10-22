// Rova self-test: uses every main feature the way a driver would, against the live city data, and says pass/fail.
//   GET /api/health    quick: server up + the last self-test result (pinged every 14 min, keeps the server awake)
//   GET /api/selftest  runs the full test (at most once an hour; otherwise returns the last result). 500 when something fails.
// Also runs a minute after every deploy and every morning. Any failure is emailed to the Rova inbox.

const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const GMAIL_USER = process.env.GMAIL_USER || "", GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const ALERT_TO = process.env.SELFTEST_EMAIL || "getrovaapp@gmail.com";

// Spots across all five boroughs, including ones drivers have reported
const AREAS = [
  ["Kensington, Caton Ave (Brooklyn)", 40.6495, -73.9681], ["Richmond Hill, 105 St (Queens)", 40.6905, -73.8410], ["NYU, Washington Pl (Manhattan)", 40.7295, -73.9955],
  ["Midtown (Manhattan)", 40.7540, -73.9840], ["Astoria (Queens)", 40.7640, -73.9230], ["Fordham (Bronx)", 40.8610, -73.8900], ["St. George (Staten Island)", 40.6430, -74.0770],
];

const get = async (path, ms = 30000) => {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
};

async function run() {
  const t0 = Date.now(), checks = [];
  const check = async (name, fn) => {
    const s = Date.now();
    try { const note = await fn(); checks.push({ name, ok: true, note: note || "", ms: Date.now() - s }); }
    catch (e) { checks.push({ name, ok: false, note: String(e.message || e).slice(0, 200), ms: Date.now() - s }); }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  await check("App page loads", async () => { const r = await get("/"); must(r.status === 200 && /maplibre/i.test(r.t), `status ${r.status}`); });

  for (const [name, lat, lng] of AREAS) await check(`Parking curbs: ${name}`, async () => {
    const d = 0.002, r = await get(`/api/park/curbs?w=${lng - d}&s=${lat - d * 0.75}&e=${lng + d}&n=${lat + d * 0.75}`, 60000);
    must(r.status === 200 && r.j, `curbs answered ${r.status}`);
    const lines = r.j.features.filter((f) => f.geometry.type === "LineString"), st = r.j.stats;
    must(st, "the city street map didn't load (curbs would fall back to rough lines)");
    must(lines.length > 0 && st.sides > 0, "no curb lines at all");
    const colored = lines.filter((f) => f.properties.s !== "none").length;
    must(colored > 0, `only gray lines (${lines.length}): no signs read`);
    must(st.unplacedSigns <= Math.max(10, 0.1 * (st.placedSigns + st.unplacedSigns)), `${st.unplacedSigns} signs couldn't be placed on the street map`);
    return `${st.sides} block sides, ${st.signed} with signs, ${st.none} gray`;
  });

  await check("Can I park here: Caton Ave answer", async () => {
    const r = await get("/api/park?lat=40.651&lng=-73.9665");
    must(r.status === 200 && r.j?.status, `answered ${r.status}`);
    must(["green", "yellow", "red"].includes(r.j.status), `odd status ${r.j.status}`);
    return `${r.j.status}: ${r.j.headline}`;
  });

  await check("Live traffic routing", async () => {
    const r = await get("/api/truck/car?pts=-73.9681,40.6495;-73.9010,40.6620", 30000);
    if (r.status === 503) return "skipped: daily traffic quota low (routes use the backup engine)";
    must(r.status === 200 && r.j?.routes?.length, `answered ${r.status} ${r.j?.error || ""}`);
    const rt = r.j.routes[0];
    must(rt.live && Array.isArray(rt.traffic), "route has no traffic data");
    return `${Math.round(rt.duration / 60)} min, ${rt.traffic.length} traffic stretches, +${Math.round((rt.trafficDelay || 0) / 60)} min delay`;
  });

  await check("Ticket lookup (city records)", async () => {
    const r = await get("/api/tickets?plate=RVTST17&state=NY", 45000);
    must(r.status === 200 && Array.isArray(r.j?.tickets), `answered ${r.status} ${r.j?.error || ""}`);
  });
  await check("Ticket lookup (review demo plate)", async () => {
    const r = await get("/api/tickets?plate=ROVADEMO&state=NY");
    must(r.status === 200 && r.j?.tickets?.length >= 1, "demo plate has no tickets (App Store reviewers would see nothing)");
  });

  await check("Speed and red-light cameras loaded", async () => {
    const r = await get("/api/cameras/status"); must(r.status === 200 && r.j, `status ${r.status}`);
    if (r.j.status !== "ready") return `still loading (${r.j.status})`;
    must(r.j.count > 0, "camera map is empty: no camera warnings"); return `${r.j.count} cameras`;
  });
  await check("Truck route network", async () => { const r = await get("/api/truck/status"); must(r.j?.status === "ready", `status ${r.j?.status} ${r.j?.error || ""}`); });
  await check("Payments set up", async () => { must(require("./billing").ready(), "Stripe webhook secret missing: paid plans wouldn't turn on"); });
  await check("Notifications set up", async () => { must(require("./push").ready(), "Firebase key missing: no push alerts"); });
  await check("Ads config", async () => { const r = await get("/api/ads/config"); must(r.status === 200 && r.j?.android, "no ad config"); return r.j.testing ? "test ads (switch to live at launch)" : "live ads"; });
  await check("AI features (sign reading, disputes)", async () => { if (!process.env.ANTHROPIC_API_KEY) return "off: no AI key yet (expected until you add one)"; });

  const failed = checks.filter((c) => !c.ok);
  const result = { ok: !failed.length, at: new Date().toISOString(), secs: Math.round((Date.now() - t0) / 1000), passed: checks.length - failed.length, failed: failed.length, checks };
  console.log(`SELFTEST ${result.ok ? "PASS" : "FAIL"} ${result.passed}/${checks.length} in ${result.secs}s` + (failed.length ? " :: " + failed.map((c) => `${c.name}: ${c.note}`).join(" | ") : ""));
  return result;
}

// ---------- scheduling, email on failure ----------
let last = null, running = null, lastMail = 0;
async function runOnce() {
  if (running) return running;
  running = run().then(async (r) => {
    last = r;
    if (!r.ok && Date.now() - lastMail > 6 * 3600e3) { lastMail = Date.now(); await email(r).catch((e) => console.error("selftest email:", e.message)); }
    return r;
  }).finally(() => (running = null));
  return running;
}
let mailer = null;
async function email(r) {
  if (!GMAIL_USER || !GMAIL_PASS) return console.log("SELFTEST: no Gmail set up, failure not emailed");
  mailer ||= require("nodemailer").createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  const bad = r.checks.filter((c) => !c.ok);
  await mailer.sendMail({ from: `Rova self-test <${GMAIL_USER}>`, to: ALERT_TO, subject: `Rova: ${bad.length} check${bad.length === 1 ? "" : "s"} failing`,
    text: `Rova's self-test found a problem (${new Date(r.at).toLocaleString("en-US", { timeZone: "America/New_York" })}).\n\nFailing:\n${bad.map((c) => `- ${c.name}: ${c.note}`).join("\n")}\n\nPassing:\n${r.checks.filter((c) => c.ok).map((c) => `- ${c.name}${c.note ? ` (${c.note})` : ""}`).join("\n")}\n\nAsk Claude to "check the self-test" and it will fix it.` });
}
function start() {
  setTimeout(() => runOnce().catch(() => {}), 60000); // after every deploy
  setInterval(() => { // every morning around 6 AM New York time
    const h = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date());
    if (h === 6 && (!last || Date.now() - new Date(last.at) > 20 * 3600e3)) runOnce().catch(() => {});
  }, 10 * 60000);
}
function routes(url, res, send) {
  if (url.pathname === "/api/health") {
    send(res, 200, { ok: true, up: true, lastSelftest: last ? { ok: last.ok, at: last.at, passed: last.passed, failed: last.failed, failing: last.checks.filter((c) => !c.ok).map((c) => c.name) } : null });
    return true;
  }
  if (url.pathname === "/api/selftest") {
    const fresh = last && Date.now() - new Date(last.at) < 3600e3;
    (fresh ? Promise.resolve(last) : runOnce()).then((r) => send(res, r.ok ? 200 : 500, r)).catch((e) => send(res, 500, { ok: false, error: e.message }));
    return true;
  }
  return false;
}
module.exports = { run, runOnce, start, routes };
