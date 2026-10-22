// The app's inline scripts must parse: one typo here blanks the whole app on every phone.
const fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let bad = 0;
blocks.forEach((b, i) => { try { new vm.Script(b, { filename: `index.html script ${i}` }); } catch (e) { bad++; console.log("FAIL", e.message, e.stack.split("\n")[0]); } });
for (const f of fs.readdirSync(path.join(__dirname, "..")).filter((f) => f.endsWith(".js"))) { try { new vm.Script(fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/^#!.*/, ""), { filename: f }); } catch (e) { bad++; console.log("FAIL", f, e.message); } }
console.log(bad ? `${bad} FAILED` : `ok: ${blocks.length} app scripts and server files parse`);
process.exit(bad ? 1 : 0);
