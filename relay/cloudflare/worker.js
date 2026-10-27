/*
 * SecureChat Mobile relay for Cloudflare Workers (free tier), same protocol as
 * relay/server.js. Each room is a Durable Object holding that room's sockets
 * and a short backlog of sealed envelopes it cannot read.
 *
 * Deploy:  cd relay/cloudflare && npx wrangler deploy
 * Then set RELAY_URL in mobile/js/config.js to  wss://<your-worker>.workers.dev/ws
 */
const ROOM_RE = /^[0-9a-f]{32}$/;
const MAX_MSG_BYTES = 16 * 1024;
const KEEP_PER_ROOM = 200;
const KEEP_MS = 7 * 24 * 3600 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("SecureChat relay", { status: 200 });
    const room = url.searchParams.get("room") || "";
    if (!ROOM_RE.test(room) || request.headers.get("Upgrade") !== "websocket") return new Response("Bad request", { status: 400 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  }
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);   // hibernation API: no cost while idle
    const log = await this.prune();
    for (const m of log) server.send(m.data);
    return new Response(null, { status: 101, webSocket: client });
  }

  async prune() {
    const now = Date.now();
    let log = (await this.state.storage.get("log")) || [];
    log = log.filter(m => now - m.at <= KEEP_MS).slice(-KEEP_PER_ROOM);
    return log;
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > MAX_MSG_BYTES) return ws.close(1009, "too big");
    let env;
    try { env = JSON.parse(data); } catch (e) { return; }
    if (!env || (env.t !== "msg" && env.t !== "hello")) return;
    const text = JSON.stringify(env);
    const log = await this.prune();
    log.push({ at: Date.now(), data: text });
    await this.state.storage.put("log", log.slice(-KEEP_PER_ROOM));
    for (const other of this.state.getWebSockets()) if (other !== ws) { try { other.send(text); } catch (e) {} }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch (e) {}
  }
}
