/*
 * core.js: SecureChat Mobile's pure logic. Keys, invites and sealed messages.
 * No DOM, no network. Works in the browser (window.SCCore) and in Node tests.
 *
 * Encryption is NaCl Box (X25519 + XSalsa20-Poly1305), the same primitive and
 * the same wire format as the desktop app: base64(nonce || ciphertext).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../vendor/nacl-fast.min.js"));
  else root.SCCore = factory(root.nacl);
})(typeof globalThis !== "undefined" ? globalThis : this, function (nacl) {
  "use strict";

  // ---------- encoding helpers (no Buffer, so they run in browsers too) ----------
  const te = new TextEncoder(), td = new TextDecoder();

  function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const b64url = bytes => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64url = s => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

  // ---------- keys ----------
  function newIdentity(name) {
    const kp = nacl.box.keyPair();
    return { name: String(name || "").trim() || "Anonymous", publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
  }

  function isPublicKey(k) {
    try { return unb64(k).length === nacl.box.publicKeyLength; } catch (e) { return false; }
  }

  /** A short, human-checkable fingerprint, e.g. "4F2A·9C01·77BE", for "do these match?" moments. */
  function fingerprint(publicKey) {
    const h = nacl.hash(unb64(publicKey));
    return hex(h.slice(0, 6)).toUpperCase().match(/.{4}/g).join("·");
  }

  // ---------- sealing (desktop-compatible) ----------
  /** Encrypt text for a peer. Returns base64(nonce || ciphertext), exactly like the desktop app. */
  function seal(text, mySecretKey, theirPublicKey) {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box(te.encode(String(text)), nonce, unb64(theirPublicKey), unb64(mySecretKey));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce); out.set(ct, nonce.length);
    return b64(out);
  }

  /** Decrypt base64(nonce || ciphertext). Returns the text, or null if it was forged or not for us. */
  function open(sealed, mySecretKey, theirPublicKey) {
    let raw;
    try { raw = unb64(sealed); } catch (e) { return null; }
    if (raw.length < nacl.box.nonceLength + nacl.box.overheadLength) return null;
    const pt = nacl.box.open(raw.subarray(nacl.box.nonceLength), raw.subarray(0, nacl.box.nonceLength),
      unb64(theirPublicKey), unb64(mySecretKey));
    return pt ? td.decode(pt) : null;
  }

  // ---------- messages ----------
  /** The inside of an envelope: what the relay can never read. */
  function packMessage(text, opts) {
    const o = opts || {};
    return JSON.stringify({ text: String(text), sd: !!o.selfDestruct, ts: o.ts || Date.now(), id: o.id || b64url(nacl.randomBytes(9)) });
  }
  function unpackMessage(json) {
    try {
      const m = JSON.parse(json);
      if (typeof m.text !== "string") return null;
      return { text: m.text, selfDestruct: !!m.sd, ts: Number(m.ts) || Date.now(), id: String(m.id || "") };
    } catch (e) { return null; }
  }

  /** Envelope sent through the relay: who it's from (public), and the sealed body. */
  function makeEnvelope(text, me, peer, opts) {
    return { t: "msg", from: me.publicKey, c: seal(packMessage(text, opts), me.secretKey, peer.key) };
  }
  function readEnvelope(env, me, peers) {
    if (!env || env.t !== "msg" || !env.from || !env.c) return null;
    const peer = peers.find(p => p.key === env.from);
    if (!peer) return null;
    const pt = open(env.c, me.secretKey, peer.key);
    const m = pt && unpackMessage(pt);
    return m ? { peer, ...m } : null;
  }

  // ---------- invites (what the QR code carries) ----------
  const INVITE_VERSION = 1;

  /** A fresh invite: your name, your public key and a random room for the two of you. */
  function newInvite(me) {
    return { v: INVITE_VERSION, n: me.name, k: me.publicKey, r: hex(nacl.randomBytes(16)) };
  }

  /** The link a phone camera opens: https://<app>/#pair=<invite>. */
  function inviteLink(origin, invite) {
    return String(origin).replace(/\/+$/, "") + "/#pair=" + b64url(te.encode(JSON.stringify(invite)));
  }

  /** Read an invite from a scanned link (or the bare #pair= fragment). Throws on anything malformed. */
  function parseInvite(text) {
    const m = String(text || "").match(/#pair=([A-Za-z0-9_-]+)/);
    if (!m) throw new Error("That QR code isn't a SecureChat invite.");
    let inv;
    try { inv = JSON.parse(td.decode(unb64url(m[1]))); } catch (e) { throw new Error("That invite is damaged. Ask for a fresh code."); }
    if (!inv || inv.v !== INVITE_VERSION) throw new Error("That invite is from a different version of SecureChat.");
    if (!isPublicKey(inv.k)) throw new Error("That invite doesn't contain a valid key.");
    if (!/^[0-9a-f]{32}$/.test(inv.r)) throw new Error("That invite doesn't contain a valid room.");
    return { name: String(inv.n || "Unknown").slice(0, 40), key: inv.k, room: inv.r };
  }

  /** Sent by the scanner into the room, so the person who showed the code can add them back. */
  function makeHello(me) { return { t: "hello", from: me.publicKey, name: me.name }; }
  function readHello(env) {
    if (!env || env.t !== "hello" || !isPublicKey(env.from)) return null;
    return { name: String(env.name || "Unknown").slice(0, 40), key: env.from };
  }

  // ---------- themes (match the desktop app) ----------
  const THEMES = {
    "Dark Teal":      { bg: "#0a0a0a", chat: "#0f0f0f", mine: "#101c30", theirs: "#0d2420", borderMine: "#1a2e4a", borderTheirs: "#0f3828", textMine: "#a0c8e8", textTheirs: "#a8d8c8", senderMine: "#4a80b0", senderTheirs: "#00d4aa", text: "#c8c8c8", accent: "#00d4aa", onAccent: "#000000", font: "'Courier New', ui-monospace, monospace", send: "TRANSMIT", sd: "#cc2222", sdBg: "#1a0d0d", dark: true },
    "Amber Terminal": { bg: "#050500", chat: "#060600", mine: "#0a0900", theirs: "#0c0a00", borderMine: "#5a4000", borderTheirs: "#c8900a", textMine: "#c8a040", textTheirs: "#a07820", senderMine: "#8a6a10", senderTheirs: "#c8900a", text: "#a08020", accent: "#c8900a", onAccent: "#000000", font: "'Courier New', ui-monospace, monospace", send: "TRANSMIT", sd: "#8b0000", sdBg: "#100000", dark: true },
    "Clean Light":    { bg: "#f4f4f4", chat: "#ffffff", mine: "#1a1a1a", theirs: "#f0f0f0", borderMine: "#111111", borderTheirs: "#e4e4e4", textMine: "#ffffff", textTheirs: "#333333", senderMine: "#4caf90", senderTheirs: "#4caf90", text: "#1a1a1a", accent: "#1a1a1a", onAccent: "#ffffff", font: "-apple-system, 'Helvetica Neue', system-ui, sans-serif", send: "Send", sd: "#cc0000", sdBg: "#fff0f0", dark: false }
  };

  return { b64, unb64, b64url, unb64url, newIdentity, isPublicKey, fingerprint, seal, open, packMessage, unpackMessage,
    makeEnvelope, readEnvelope, newInvite, inviteLink, parseInvite, makeHello, readHello, THEMES };
});
