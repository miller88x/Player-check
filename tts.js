// Natural navigation voice: Google Cloud Text-to-Speech (newest "Chirp 3 HD" voices, falls back to Neural2).
// Needs GOOGLE_TTS_KEY. Without it the app uses the phone's built-in voice.
// Each phrase is made once and cached (memory + /tmp + the phone's own cache), so repeat phrases cost nothing.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = (process.env.GOOGLE_TTS_KEY || "").replace(/[\s​-‍﻿ ]/g, "");
const VOICES = [process.env.TTS_VOICE || "en-US-Chirp3-HD-Aoede", "en-US-Neural2-F"];
const DIR = "/tmp/tts";
const mem = new Map();
let lastError = null, voiceUsed = null;
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

async function synth(text) {
  const id = crypto.createHash("sha1").update(VOICES[0] + "|" + text).digest("hex");
  if (mem.has(id)) return mem.get(id);
  const file = path.join(DIR, id + ".mp3");
  try { const b = fs.readFileSync(file); mem.set(id, b); return b; } catch {}
  let err;
  for (const name of VOICES) {
    try {
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ input: { text }, voice: { languageCode: "en-US", name }, audioConfig: { audioEncoding: "MP3", speakingRate: name.includes("Chirp") ? 1 : 1.05 } }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || `TTS ${res.status}`);
      const b = Buffer.from(j.audioContent, "base64");
      mem.set(id, b); if (mem.size > 800) mem.delete(mem.keys().next().value);
      try { fs.writeFileSync(file, b); } catch {}
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
  if (url.pathname === "/api/tts/status") { send(res, 200, { ready: !!KEY, voice: voiceUsed || VOICES[0], lastError }); return true; }
  if (url.pathname !== "/api/tts") return false;
  const text = String(url.searchParams.get("t") || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!KEY || !text) { send(res, KEY ? 400 : 503, { error: "Voice not available" }); return true; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  if (limited(ip)) { send(res, 429, { error: "Too many" }); return true; }
  synth(text)
    .then((b) => { res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": b.length, "Cache-Control": "public, max-age=2592000" }); res.end(b); })
    .catch((e) => { console.error("tts:", lastError || e.message); send(res, 502, { error: "Voice failed" }); });
  return true;
}

module.exports = { routes };
