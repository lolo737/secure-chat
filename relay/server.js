/*
 * SecureChat Mobile relay + app server.
 *
 *   node relay/server.js            # http://localhost:8787  (app)   ws://localhost:8787/ws  (relay)
 *   PORT=9000 node relay/server.js
 *
 * The relay is a post box for sealed envelopes. Messages are encrypted on the
 * phones before they arrive, so it can't read them: it only sees which room an
 * envelope belongs to, its size and when it came. It keeps the last few
 * envelopes per room for a while, so a phone that was offline catches up.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const ROOM_RE = /^[0-9a-f]{32}$/;
const MAX_MSG_BYTES = 16 * 1024;     // text messages only; plenty
const KEEP_PER_ROOM = 200;
const KEEP_MS = 7 * 24 * 3600 * 1000; // a week
const MAX_PER_SOCKET_PER_MIN = 120;

function createRelay() {
  const rooms = new Map(); // room -> { sockets:Set, log:[{at, data}] }

  function room(id) {
    let r = rooms.get(id);
    if (!r) { r = { sockets: new Set(), log: [] }; rooms.set(id, r); }
    return r;
  }
  function prune(r, now) {
    while (r.log.length && (r.log.length > KEEP_PER_ROOM || now - r.log[0].at > KEEP_MS)) r.log.shift();
  }

  function onConnection(ws, roomId) {
    const r = room(roomId);
    r.sockets.add(ws);
    prune(r, Date.now());
    for (const m of r.log) ws.send(m.data);         // catch up on what you missed
    let windowStart = Date.now(), count = 0;
    ws.on("error", () => { try { ws.terminate(); } catch (e) {} }); // oversized or broken frames: drop that socket, never the server

    ws.on("message", (data, isBinary) => {
      if (isBinary || data.length > MAX_MSG_BYTES) return ws.close(1009, "too big");
      const now = Date.now();
      if (now - windowStart > 60000) { windowStart = now; count = 0; }
      if (++count > MAX_PER_SOCKET_PER_MIN) return ws.close(1008, "slow down");
      let env;
      try { env = JSON.parse(data.toString()); } catch (e) { return; }
      if (!env || (env.t !== "msg" && env.t !== "hello")) return; // only the two envelope types
      const text = JSON.stringify(env);
      r.log.push({ at: now, data: text }); prune(r, now);
      for (const other of r.sockets) if (other !== ws && other.readyState === 1) other.send(text);
    });
    ws.on("close", () => {
      r.sockets.delete(ws);
      if (!r.sockets.size && !r.log.length) rooms.delete(roomId);
    });
  }

  return { onConnection, rooms };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };

function createServer(appDir) {
  const relay = createRelay();
  const root = path.resolve(appDir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const file = path.resolve(root, "." + p);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(buf);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url, "http://x");
    const roomId = u.searchParams.get("room") || "";
    if (u.pathname !== "/ws" || !ROOM_RE.test(roomId)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => relay.onConnection(ws, roomId));
  });
  return { server, relay };
}

module.exports = { createServer, createRelay };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  const { server } = createServer(path.join(__dirname, "..", "mobile"));
  server.listen(port, () => {
    console.log(`SecureChat Mobile on http://localhost:${port}`);
    console.log(`Relay at ws://localhost:${port}/ws`);
    console.log("Phones need HTTPS for the in-app camera and Add to Home Screen. See mobile/README.md.");
  });
}
