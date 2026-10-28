/*
 * Every button on the pairing screen must be fully on screen, on small Android
 * phones and with Android's large-text setting on. (This once wasn't true on a
 * Samsung: the buttons sat cut off under the browser's bottom bar.)
 * Run: npm run test:screens   (needs Playwright)
 */
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium, devices } = require("playwright");
const { createServer } = require("../../relay/server.js");

const PHONES = [
  ["iPhone 11", devices["iPhone 11"], false],
  ["Samsung with browser bars", { ...devices["Galaxy S9+"], viewport: { width: 360, height: 560 } }, false],
  ["Samsung, large text", { ...devices["Galaxy S9+"], viewport: { width: 360, height: 560 } }, true],
  ["Small Android", { ...devices["Galaxy S9+"], viewport: { width: 320, height: 500 } }, false],
];

(async () => {
  const { server } = createServer(path.join(__dirname, ".."));
  await new Promise(r => server.listen(0, r));
  const URL = `http://localhost:${server.address().port}/`;
  const b = await chromium.launch();
  let failed = 0;
  for (const [name, opts, bigText] of PHONES) {
    const ctx = await b.newContext(opts), p = await ctx.newPage();
    await p.goto(URL); await p.fill("#setupName", "Test"); await p.click("#setupGo");
    if (bigText) await p.evaluate(() => { for (const el of document.querySelectorAll("body *")) el.style.fontSize = parseFloat(getComputedStyle(el).fontSize) * 1.3 + "px"; });
    await p.click("#showCode"); await p.waitForTimeout(200);
    const r = await p.evaluate(() => {
      const vh = innerHeight, box = s => document.querySelector(s).getBoundingClientRect();
      const qr = document.getElementById("qr"), d = qr.getContext("2d").getImageData(0, 0, qr.width, qr.height);
      return { vh, copy: box("#copyLink").bottom, fresh: box("#newCode").bottom, x: box("#code [data-close]").top, scans: !!jsQR(d.data, qr.width, qr.height) };
    });
    const ok = r.copy <= r.vh && r.fresh <= r.vh && r.x >= 0 && r.scans;
    console.log(`${ok ? "✓" : "✗"} ${name}: buttons ${r.copy <= r.vh && r.fresh <= r.vh ? "on screen" : "CUT OFF"}, close button ${r.x >= 0 ? "visible" : "missing"}, QR ${r.scans ? "scans" : "DOESN'T SCAN"}`);
    if (!ok) failed++;
    await ctx.close();
  }
  await b.close(); server.close();
  assert.equal(failed, 0, `${failed} phone size(s) failed`);
})().catch(e => { console.error("✗", e.message); process.exit(1); });
