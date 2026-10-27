/*
 * The whole story on two emulated phones: an iPhone (Jack) and an Android (Maya).
 * Needs Playwright:  npm i -D playwright && npx playwright install chromium
 * Run:               npm run test:phones
 */
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium, devices } = require("playwright");
const { createServer } = require("../../relay/server.js");

(async () => {
  const { server } = createServer(path.join(__dirname, ".."));
  await new Promise(r => server.listen(0, r));
  const URL = `http://localhost:${server.address().port}/`;
  const b = await chromium.launch();
  const jackCtx = await b.newContext({ ...devices["iPhone 13"] }), mayaCtx = await b.newContext({ ...devices["Pixel 7"] });
  const jack = await jackCtx.newPage(), maya = await mayaCtx.newPage();
  const errs = []; for (const p of [jack, maya]) p.on("pageerror", e => errs.push(e.message));
  const step = s => console.log("✓", s);

  await jack.goto(URL); await jack.fill("#setupName", "Jack"); await jack.click("#setupGo");
  await jack.click("#showCode");
  const link = await jack.evaluate(() => { const c = document.getElementById("qr"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height); return jsQR(d.data, c.width, c.height).data; });
  assert.match(link, /#pair=/); step("Jack's QR decodes to an invite link");

  await maya.goto(link); await maya.fill("#setupName", "Maya"); await maya.click("#setupGo");
  await maya.waitForSelector("#chat:not([hidden])"); assert.equal(await maya.textContent("#chatName"), "Jack");
  step("Maya opens the link, sets up, and lands in a chat with Jack");

  await jack.waitForSelector("#confirm[open]"); assert.match(await jack.textContent("#confirmText"), /Pair with Maya\?/);
  await jack.click("#confirmYes"); await jack.waitForSelector("#chat:not([hidden])"); step("Jack confirms the pairing");

  await maya.fill("#text", "Are you still coming tonight?"); await maya.click("#send");
  await jack.waitForSelector(".b:not(.mine) .t >> text=Are you still coming tonight?"); step("Maya → Jack");
  await jack.fill("#text", "On my way."); await jack.click("#send");
  await maya.waitForSelector(".b:not(.mine) .t >> text=On my way."); step("Jack → Maya");

  await jack.check("#sd"); await jack.fill("#text", "Burn this after reading."); await jack.click("#send");
  await maya.waitForSelector(".b.sd:not(.mine)"); await maya.waitForSelector(".gone", { timeout: 9000 }); step("self-destruct message burns itself");

  await maya.close(); await jack.fill("#text", "Text me when you're out"); await jack.click("#send"); await jack.waitForTimeout(300);
  const maya2 = await mayaCtx.newPage(); await maya2.goto(URL); await maya2.click("#peers li button");
  await maya2.waitForSelector(".t >> text=Text me when you're out"); step("Maya catches up after being offline");

  assert.deepEqual(errs, []); console.log("All good: no errors on either phone.");
  await b.close(); server.close();
})().catch(e => { console.error("✗", e.message); process.exit(1); });
