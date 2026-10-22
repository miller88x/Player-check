// Run before shipping: node tests/park.test.js  (exits 1 on any failure)
// Real city sign rows for blocks where Rova was once wrong, with the answer a driver standing there should get.
const assert = require("assert");
const park = require("../park");
let fails = 0;
const t = async (name, fn) => { try { await fn(); console.log("ok  ", name); } catch (e) { fails++; console.log("FAIL", name, "-", e.message); } };

(async () => {
  const caton = require("./caton-rows");
  global.fetch = async () => ({ ok: true, json: async () => caton.map((r) => ({ ...r })) });
  const ux = 993958 - 992214, uy = 176362 - 175499;
  // Caton Ave N side, Parade Pl -> Coney Island Ave, Thu Oct 22 2026 1:40 PM: driveway / bus-stop "anytime" arrows must not run to the corner
  for (const f of [0.15, 0.45, 0.62, 0.7, 0.8, 0.9]) await t(`Caton Ave N side at ${Math.round(f * 100)}% of the block is green (street cleaning only)`, async () => {
    const [la, ln] = park.toLatLng(992214 + ux * f, 175499 + uy * f);
    const r = await park.check(la, ln, new Date("2026-10-22T17:40:00Z"));
    assert.strictEqual(r.status, "green", r.headline);
    assert.deepStrictEqual(r.rules.map((x) => x.split(" ")[0]), ["Street"], r.rules.join(" ; "));
  });
  await t("Caton Ave: the real driveway right after the 'No parking anytime -->' pole stays red", async () => {
    const z = park.curbZones(caton, 992862, 175814).filter((z) => z.here).map((z) => z.rule.label);
    assert(z.includes("No parking"), z.join(", "));
  });
  await t("riders are not rules", async () => {
    assert.strictEqual(park.parseSign("METERS ARE NOT IN EFFECT ABOVE TIMES (TO BE USED ONLY FOR COMMERCIAL VEHICLE METERING)"), null);
    assert.strictEqual(park.parseSign("CONSUL / DIPLOMAT CODING RIDER (SIGN CAN CONTAIN 1 TO 4 CODES)"), null);
  });
  await t("a time-limited rule is never cut short by a meter (no false green)", async () => {
    const g = new Map([["BROOM", { rule: park.parseSign("NO PARKING (SANITATION BROOM SYMBOL) MONDAY 8AM-9AM"), signs: [{ p: 0, dir: 1 }] }],
      ["HMP", { rule: park.parseSign("2 HMP 9AM-7PM EXCEPT SUNDAY"), signs: [{ p: 100, dir: 1 }] }]]);
    const broom = park.zoneIntervals(g, -40, 300).find((z) => z.raw === "BROOM");
    assert.deepStrictEqual(broom.iv, [[0, 300]]);
  });
  console.log(fails ? `${fails} FAILED` : "all passed");
  process.exit(fails ? 1 : 0);
})();
