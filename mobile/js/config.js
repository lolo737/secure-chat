/*
 * config.js: where the relay lives.
 *
 * Blank = the same site the app is served from (what relay/server.js does).
 * If you host the app on Netlify or GitHub Pages and the relay on Cloudflare,
 * put the Worker's address here, e.g. "wss://securechat-relay.<you>.workers.dev/ws".
 * Each phone can also override it in Settings.
 */
self.SC_CONFIG = { relayUrl: "" };
