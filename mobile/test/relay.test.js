const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const WebSocket = require("ws");
const { createServer } = require("../../relay/server.js");

function start() {
  const { server } = createServer(path.join(__dirname, ".."));
  return new Promise(r => server.listen(0, () => r({ server, port: server.address().port })));
}
const open = (port, room) => new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${port}/ws?room=${room}`); ws.once("open", () => res(ws)); ws.once("error", rej); });
const next = ws => new Promise(r => ws.once("message", d => r(JSON.parse(d.toString()))));
const ROOM = "0123456789abcdef0123456789abcdef";

test("relay passes envelopes between the two phones in a room", async () => {
  const { server, port } = await start();
  const a = await open(port, ROOM), b = await open(port, ROOM);
  const got = next(b);
  a.send(JSON.stringify({ t: "msg", from: "AAA", c: "sealed" }));
  assert.deepEqual(await got, { t: "msg", from: "AAA", c: "sealed" });
  a.close(); b.close(); server.close();
});

test("a phone that was offline catches up on join", async () => {
  const { server, port } = await start();
  const a = await open(port, ROOM);
  a.send(JSON.stringify({ t: "hello", from: "KEY", name: "Maya" }));
  await new Promise(r => setTimeout(r, 50));
  const b = new WebSocket(`ws://localhost:${port}/ws?room=${ROOM}`);
  assert.deepEqual(await next(b), { t: "hello", from: "KEY", name: "Maya" });
  a.close(); b.close(); server.close();
});

test("relay refuses bad rooms, junk and oversized messages, and keeps rooms apart", async () => {
  const { server, port } = await start();
  await assert.rejects(open(port, "not-a-room"));
  const a = await open(port, ROOM), other = await open(port, "f".repeat(32));
  let leaked = false; other.on("message", () => (leaked = true));
  a.send("not json"); a.send(JSON.stringify({ t: "admin", cmd: "x" }));
  a.send(JSON.stringify({ t: "msg", from: "A", c: "x" }));
  const closed = new Promise(r => a.once("close", (code) => r(code)));
  a.send(JSON.stringify({ t: "msg", from: "A", c: "x".repeat(20000) }));
  assert.equal(await closed, 1009);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(leaked, false, "other room heard nothing");
  other.close(); server.close();
});

test("the app server serves files but not outside its folder", async () => {
  const { server, port } = await start();
  const ok = await fetch(`http://localhost:${port}/`); assert.equal(ok.status, 200);
  assert.match(await ok.text(), /SECURECHAT/);
  const bad = await fetch(`http://localhost:${port}/..%2f..%2frelay%2fserver.js`); assert.notEqual(bad.status, 200);
  server.close();
});
