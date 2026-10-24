// "Ask Rova": type (or say) a question instead of a place, e.g.
//   "where can I park near Barclays for 2 hours"   -> parking check at Barclays
//   "truck route to Hunts Point avoiding tolls"    -> truck directions with tolls avoided
//   "gas near me" / "cheap coffee on the way"       -> nearby search
//   "do I have any tickets"                         -> your tickets
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise a built-in phrase reader handles the common questions.
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ASK_MODEL || "claude-haiku-5-5";

const CAT_WORDS = [
  ["gas", /\b(gas|fuel|petrol|gas station|fill up)\b/i],
  ["ev", /\b(ev|charg(e|er|ing)|electric)\b/i],
  ["parking", /\b(garage|parking lot|lot)\b/i],
  ["coffee", /\b(coffee|cafe|café|espresso|starbucks|dunkin)\b/i],
  ["food", /\b(food|eat|restaurant|lunch|dinner|breakfast|pizza|burger|halal)\b/i],
  ["carwash", /\b(car ?wash|wash my car)\b/i],
];
const clean = (s) => String(s || "").replace(/[?.!]+$/, "").replace(/\b(please|right now|now|for me)\b/gi, "").replace(/\s+/g, " ").trim();

// Built-in reader: good enough for the everyday questions, no AI needed
function rules(q) {
  const t = q.toLowerCase();
  const go = t.match(/^(?:take me|go|drive|navigate|get me|bring me|head)\s+(?:to\s+)?(?:my\s+)?(home|house|work|job|office)\b/);
  if (go) return { action: "route", place: /home|house/.test(go[1]) ? "home" : "work", mode: /\btruck\b/.test(t) ? "truck" : "car", avoid: [] };
  const place = (() => {
    const m = t.match(/\b(?:near|by|around|at|on|close to|next to|to|towards|toward|in)\s+(.+?)(?:\s+(?:for|until|till|avoid(?:ing)?|without|with|by truck|in my truck|as a truck|tonight|today|tomorrow)\b.*)?$/);
    const p = m ? clean(m[1]).replace(/^(the|a)\s+/, "") : "";
    if (/^(my )?(house|home|place|apartment|crib)$/.test(p)) return "home";
    if (/^(my )?(job|work|office)$/.test(p)) return "work";
    return p && !/^(me|here|my location|my spot|this spot)$/.test(p) ? p : null;
  })();
  const k = place ? t.replace(place, " ") : t; // look for keywords outside the place name ("coffee near Prospect Park" isn't parking)
  const hours = (() => { const m = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/); return m ? +m[1] : /\ball day\b/.test(t) ? 8 : /\bovernight\b/.test(t) ? 12 : null; })();
  for (const [cat, re] of CAT_WORDS) if (re.test(k) && !/\b(route|directions|take me|navigate|drive)\b/.test(k)) return { action: "nearby", category: cat, place };
  if (/\b(ticket|tickets|summons|fine|fines|owe|tow(ed)?|boot(ed)?)\b/.test(k) && !/\bpark\b/.test(k)) return { action: "tickets" };
  if (/\b(park|parking|spot|curb|meter|alternate side|street cleaning)\b/.test(k)) return { action: "park", place, hours };
  const avoid = [/\btolls?\b/.test(t) && /\b(avoid\w*|no|without|skip\w*)\b/.test(t) && "tolls", /\b(highway|highways|expressway|freeway)s?\b/.test(t) && /\b(avoid\w*|no|without|skip\w*)\b/.test(t) && "highways"].filter(Boolean);
  const truck = /\b(truck|trucks|semi|tractor.?trailer|box truck|18.?wheeler|commercial)\b/.test(t);
  if (/\b(route|directions|take me|navigate|drive|go|get|how do i get|way)\b/.test(t) && place) return { action: "route", place, mode: truck ? "truck" : "car", avoid };
  if (place) return { action: "route", place, mode: truck ? "truck" : "car", avoid };
  return { action: "place", place: clean(q) };
}

const SYSTEM = `You turn a driver's request in the Rova driving app (New York City, works nationwide) into ONE JSON action. Reply with JSON only, no prose.
Actions:
{"action":"park","place":string|null,"hours":number|null}  - can I park / where to park / street parking / meters / alternate side. place null = where the driver is now.
{"action":"route","place":string,"mode":"car"|"truck","avoid":["tolls"|"highways"]} - directions somewhere. mode truck if they mention a truck, semi, box truck, commercial vehicle.
{"action":"nearby","category":"gas"|"parking"|"coffee"|"food"|"ev"|"carwash","place":string|null} - find a kind of place (parking = garages/lots).
{"action":"tickets"} - their parking/camera tickets, fines, tow or boot.
{"action":"place","place":string} - just a place or address to look up.
{"action":"answer","text":string} - a short helpful answer (under 60 words) when none of the above fit (e.g. general NYC parking rules). Be accurate; if unsure say to check posted signs.
"place" must be a searchable name or address (e.g. "Barclays Center Brooklyn", "Hunts Point Bronx"), not a full sentence.`;

async function ai(q, near) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, system: SYSTEM, messages: [{ role: "user", content: `${near ? `Driver is near ${near}.\n` : ""}Request: ${q}` }] }),
    signal: AbortSignal.timeout(9000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `AI ${r.status}`);
  const txt = (j.content || []).map((c) => c.text || "").join("");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON");
  const a = JSON.parse(m[0]);
  if (!["park", "route", "nearby", "tickets", "place", "answer"].includes(a.action)) throw new Error("bad action");
  return a;
}

const rate = new Map();
function routes(url, res, send, readBody, req) {
  if (url.pathname !== "/api/ask" || req.method !== "POST") return false;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  const w = rate.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - w.t > 60000) { w.n = 0; w.t = Date.now(); }
  if (++w.n > 30) { send(res, 429, { error: "Too many questions, try again in a minute." }); return true; }
  rate.set(ip, w); if (rate.size > 20000) rate.clear();
  readBody(req).then(async (b) => {
    const q = String(b.q || "").slice(0, 300).trim();
    if (q.length < 2) return send(res, 400, { error: "Ask something" });
    let a = null, via = "rules";
    if (API_KEY) { try { a = await ai(q, String(b.near || "").slice(0, 80)); via = "ai"; } catch (e) { console.error("ask AI:", e.message); } }
    if (!a) a = rules(q);
    send(res, 200, { ...a, via });
  }).catch(() => send(res, 400, { error: "bad body" }));
  return true;
}

module.exports = { routes, rules };
