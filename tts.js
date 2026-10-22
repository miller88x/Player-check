// Natural navigation voice: Google Cloud Text-to-Speech (newest "Chirp 3 HD" voices, falls back to Neural2).
// Needs GOOGLE_TTS_KEY. Without it the app uses the phone's built-in voice.
// Each phrase is made once and kept for good: memory → /tmp → Supabase Storage (bucket "rova-tts", survives Render
// restarts and new deploys) → the phone's own cache. A phrase any driver has heard is never paid for again.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = (process.env.GOOGLE_TTS_KEY || "").replace(/[\s​-‍﻿ ]/g, "");
// Voices drivers can pick from (Google's newest Chirp 3 HD voices). Anything else falls back to the default.
const CHOICES = {
  "en-US-Chirp3-HD-Aoede": 1, "en-US-Chirp3-HD-Kore": 1, "en-US-Chirp3-HD-Leda": 1, "en-US-Chirp3-HD-Puck": 1,
  "en-US-Chirp3-HD-Charon": 1, "en-US-Chirp3-HD-Fenrir": 1, "en-GB-Chirp3-HD-Aoede": 1, "en-GB-Chirp3-HD-Puck": 1,
  "en-AU-Chirp3-HD-Aoede": 1, "en-IN-Chirp3-HD-Kore": 1,
};
const DEFAULT = process.env.TTS_VOICE || "en-US-Chirp3-HD-Aoede";
const FALLBACK = "en-US-Neural2-F";
const DIR = "/tmp/tts";
const mem = new Map();
let lastError = null, voiceUsed = null;
const stats = { mem: 0, disk: 0, store: 0, google: 0, storeErr: null };

// ---------- Supabase Storage (same project as the app's tables) ----------
const SB_URL = (process.env.SUPABASE_URL || "").replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || "").replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, "");
const BUCKET = "rova-tts";
const sbHeaders = (extra = {}) => ({ apikey: SB_KEY, ...(SB_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}), ...extra });
let bucketReady = null;
function ensureBucket() {
  if (!SB_URL || !SB_KEY) return Promise.resolve(false);
  return (bucketReady ||= fetch(`${SB_URL}/storage/v1/bucket`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 1048576, allowed_mime_types: ["audio/mpeg"] }), signal: AbortSignal.timeout(8000) })
    .then(async (r) => { if (r.ok || r.status === 409 || /already exists|Duplicate/i.test(await r.text().catch(() => ""))) return true; throw new Error(`bucket ${r.status}`); })
    .catch((e) => { stats.storeErr = e.message; bucketReady = null; return false; }));
}
async function storeGet(id) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${id}.mp3`, { headers: sbHeaders(), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}
async function storePut(id, buf) {
  if (!(await ensureBucket())) return;
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${id}.mp3`, { method: "POST", headers: sbHeaders({ "Content-Type": "audio/mpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000" }), body: buf, signal: AbortSignal.timeout(10000) });
    if (!r.ok) stats.storeErr = `upload ${r.status}: ${(await r.text()).slice(0, 120)}`;
  } catch (e) { stats.storeErr = e.message; }
}
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

async function synth(text, want) {
  const VOICES = [CHOICES[want] ? want : DEFAULT, FALLBACK];
  const id = crypto.createHash("sha1").update(VOICES[0] + "|" + text).digest("hex");
  const keep = (b) => { mem.set(id, b); if (mem.size > 800) mem.delete(mem.keys().next().value); };
  if (mem.has(id)) { stats.mem++; return mem.get(id); }
  const file = path.join(DIR, id + ".mp3");
  try { const b = fs.readFileSync(file); keep(b); stats.disk++; return b; } catch {}
  const saved = await storeGet(id);
  if (saved && saved.length > 100) { keep(saved); try { fs.writeFileSync(file, saved); } catch {} stats.store++; return saved; }
  let err;
  for (const name of VOICES) {
    try {
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ input: { text }, voice: { languageCode: name.slice(0, 5), name }, audioConfig: { audioEncoding: "MP3", speakingRate: name.includes("Chirp") ? 1 : 1.05 } }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || `TTS ${res.status}`);
      const b = Buffer.from(j.audioContent, "base64");
      keep(b); stats.google++;
      try { fs.writeFileSync(file, b); } catch {}
      storePut(id, b); // saved for good in the background
      voiceUsed = name; lastError = null;
      return b;
    } catch (e) { err = e; lastError = `${name}: ${String(e.message).replace(KEY, "[key]")}`; }
  }
  throw err;
}

const rate = new Map();
function limited(ip) { // 300 new phrases per visitor per hour
  const k = `${ip}|${Math.floor(Date.now() / 3600000)}`, n = (rate.get(k) || 0) + 1;
  rate.set(k, n); if (rate.size > 20000) rate.clear();
  return n > 300;
}

function routes(url, res, send, req) {
  if (url.pathname === "/api/tts/status") { send(res, 200, { ready: !!KEY, voice: voiceUsed || DEFAULT, voices: Object.keys(CHOICES), lastError, storage: !!(SB_URL && SB_KEY), served: stats }); return true; }
  if (url.pathname !== "/api/tts") return false;
  const text = String(url.searchParams.get("t") || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!KEY || !text) { send(res, KEY ? 400 : 503, { error: "Voice not available" }); return true; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  if (limited(ip)) { send(res, 429, { error: "Too many" }); return true; }
  synth(text, String(url.searchParams.get("v") || ""))
    .then((b) => { res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": b.length, "Cache-Control": "public, max-age=2592000" }); res.end(b); })
    .catch((e) => { console.error("tts:", lastError || e.message); send(res, 502, { error: "Voice failed" }); });
  return true;
}

module.exports = { routes };
