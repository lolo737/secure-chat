/* app.js: SecureChat Mobile. Screens, storage, relay sockets, QR show and scan. */
(function () {
  "use strict";
  const C = self.SCCore;
  const $ = id => document.getElementById(id);
  const KEY = "securechat.mobile.v1";

  // ---------- state ----------
  // { me:{name,publicKey,secretKey}, theme, relay, peers:[{name,key,room,added}], invites:[{room,made}], msgs:{[key]:[...]}}
  let S = load();
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.me) return { peers: [], invites: [], msgs: {}, theme: "Dark Teal", relay: "", ...s }; } catch (e) {}
    return null;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast("This phone won't let SecureChat save. Private browsing?"); }
  }

  // ---------- theme ----------
  const VARS = { bg: "--bg", chat: "--chat", mine: "--mine", theirs: "--theirs", borderMine: "--border-mine", borderTheirs: "--border-theirs",
    textMine: "--text-mine", textTheirs: "--text-theirs", senderMine: "--sender-mine", senderTheirs: "--sender-theirs", text: "--text",
    accent: "--accent", onAccent: "--on-accent", font: "--font", sd: "--sd", sdBg: "--sd-bg" };
  function applyTheme(name) {
    const t = C.THEMES[name] || C.THEMES["Dark Teal"];
    for (const [k, v] of Object.entries(VARS)) document.documentElement.style.setProperty(v, t[k]);
    document.querySelector('meta[name="theme-color"]').content = t.bg;
    $("send").textContent = t.send;
    $("text").placeholder = "Message…";
  }
  function themePicker(el, current, onPick) {
    el.innerHTML = "";
    for (const name of Object.keys(C.THEMES)) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = name;
      b.setAttribute("aria-pressed", String(name === current));
      b.onclick = () => { onPick(name); themePicker(el, name, onPick); };
      el.appendChild(b);
    }
  }

  // ---------- screens ----------
  const nav = [];
  function show(id, push) {
    document.querySelectorAll(".screen").forEach(s => (s.hidden = s.id !== id));
    if (push !== false) nav.push(id);
    if (id !== "scan") stopCamera();
  }
  // ---------- full screen ----------
  // Android browsers let a page take over the whole screen (after a tap). iPhones only do it
  // for apps added to the Home Screen, so there we show a one-time tip instead.
  const UA = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(UA);
  const installed = (window.matchMedia && matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches) || navigator.standalone === true;
  const canFull = !isIOS && !installed && !!(document.documentElement.requestFullscreen && document.fullscreenEnabled);
  function enterFull() {
    if (!canFull || !isAndroid || document.fullscreenElement) return;
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }
  function exitFull() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  function setupFullUI() {
    const btn = $("fullBtn");
    btn.hidden = !canFull;
    btn.onclick = () => (document.fullscreenElement ? exitFull() : document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => toast("This browser won't go full screen")));
    document.addEventListener("fullscreenchange", () => { btn.textContent = document.fullscreenElement ? "⤡" : "⛶"; btn.setAttribute("aria-label", document.fullscreenElement ? "Exit full screen" : "Full screen"); });
    let dismissed = false; try { dismissed = localStorage.getItem("sc-ios-hint") === "1"; } catch (e) {}
    $("iosHint").hidden = !(isIOS && !installed && !dismissed);
    $("iosHintX").onclick = () => { $("iosHint").hidden = true; try { localStorage.setItem("sc-ios-hint", "1"); } catch (e) {} };
  }

  // The big X on the code and camera screens: straight home, out of full screen.
  document.addEventListener("click", e => {
    if (!e.target.closest("[data-close]")) return;
    exitFull(); renderHome(); nav.length = 0; nav.push("home"); show("home", false);
  });

  document.addEventListener("click", e => {
    if (!e.target.closest("[data-back]")) return;
    nav.pop();
    const prev = nav[nav.length - 1] || "home";
    if (prev === "home") renderHome();
    show(prev, false);
  });
  function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2600); }
  function ask(text) {
    return new Promise(res => {
      const d = $("confirm"); $("confirmText").textContent = text;
      $("confirmYes").onclick = () => { d.close(); res(true); };
      $("confirmNo").onclick = () => { d.close(); res(false); };
      d.showModal();
    });
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // ---------- setup ----------
  let setupTheme = "Dark Teal";
  function startSetup() {
    applyTheme(setupTheme);
    themePicker($("setupThemes"), setupTheme, n => { setupTheme = n; applyTheme(n); });
    show("setup");
  }
  $("setupGo").onclick = () => {
    const name = $("setupName").value.trim();
    if (!name) { $("setupName").focus(); toast("Pick a name the other phone will see"); return; }
    S = { me: C.newIdentity(name), theme: setupTheme, relay: "", peers: [], invites: [], msgs: {} };
    save(); boot();
  };

  // ---------- relay sockets: one per room ----------
  const socks = new Map(); // room -> {ws, tries, timer}
  function relayBase() {
    const u = (S.relay || (self.SC_CONFIG && self.SC_CONFIG.relayUrl) || "").trim();
    if (u) return u.replace(/\/+$/, "");
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  }
  function connect(room) {
    if (socks.has(room)) return;
    const entry = { ws: null, tries: 0, timer: null };
    socks.set(room, entry);
    const open = () => {
      let ws;
      try { ws = new WebSocket(relayBase() + "?room=" + room); } catch (e) { return retry(); }
      entry.ws = ws;
      ws.onopen = () => { entry.tries = 0; onlineChanged(); };
      ws.onmessage = ev => { try { onEnvelope(room, JSON.parse(ev.data)); } catch (e) {} };
      ws.onclose = () => { onlineChanged(); retry(); };
    };
    const retry = () => {
      if (!socks.has(room)) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(open, Math.min(30000, 1000 * 2 ** entry.tries++));
    };
    open();
  }
  function disconnect(room) {
    const e = socks.get(room); if (!e) return;
    socks.delete(room); clearTimeout(e.timer); try { e.ws && e.ws.close(); } catch (x) {}
  }
  function sendTo(room, env) {
    const e = socks.get(room);
    if (e && e.ws && e.ws.readyState === 1) { e.ws.send(JSON.stringify(env)); return true; }
    return false;
  }
  const isOnline = room => { const e = socks.get(room); return !!(e && e.ws && e.ws.readyState === 1); };

  // Messages that couldn't go yet (offline) wait here and go on reconnect.
  const outbox = [];
  function flush() {
    for (let i = outbox.length - 1; i >= 0; i--) if (sendTo(outbox[i].room, outbox[i].env)) outbox.splice(i, 1);
  }
  function onlineChanged() { flush(); if (current) renderChatState(); }

  // ---------- incoming ----------
  async function onEnvelope(room, env) {
    if (!env || env.from === S.me.publicKey) return;          // our own echo or backlog
    if (env.t === "hello") return onHello(room, env);
    const m = C.readEnvelope(env, S.me, S.peers);
    if (!m) return;
    const list = (S.msgs[m.peer.key] ||= []);
    if (m.id && list.some(x => x.id === m.id)) return;      // already have it (backlog replay)
    list.push({ id: m.id, mine: false, text: m.text, ts: m.ts, sd: m.selfDestruct });
    trim(list); save();
    if (current && current.key === m.peer.key) renderMsgs(); else { toast("New message from " + m.peer.name); renderHome(); }
  }

  async function onHello(room, env) {
    const h = C.readHello(env); if (!h) return;
    if (S.peers.some(p => p.key === h.key)) return;          // already paired
    const inv = S.invites.find(i => i.room === room);
    if (!inv) return;                                          // not a room we invited anyone to
    const ok = await ask(`Pair with ${h.name}?\nTheir fingerprint: ${C.fingerprint(h.key)}`);
    if (!ok) return;
    S.peers.push({ name: h.name, key: h.key, room, added: Date.now() });
    S.invites = S.invites.filter(i => i.room !== room);
    save(); toast("Paired with " + h.name);
    openChat(S.peers[S.peers.length - 1]);
  }

  // ---------- pairing: show a code ----------
  let myInvite = null;
  function showCode(fresh) {
    if (fresh || !myInvite) {
      myInvite = C.newInvite(S.me);
      S.invites = [...S.invites.filter(i => Date.now() - i.made < 864e5), { room: myInvite.r, made: Date.now() }].slice(-5);
      save(); connect(myInvite.r);
    }
    const link = C.inviteLink(location.origin + location.pathname.replace(/[^/]*$/, ""), myInvite);
    drawQR($("qr"), link);
    $("copyLink").onclick = () => { navigator.clipboard && navigator.clipboard.writeText(link).then(() => toast("Invite link copied"), () => toast(link)); };
    $("myFp").textContent = C.fingerprint(S.me.publicKey);
    show("code");
  }
  function drawQR(canvas, text) {
    const q = qrcode(0, "M"); q.addData(text); q.make();
    const n = q.getModuleCount(), quiet = 4, size = n + quiet * 2, scale = Math.max(4, Math.floor(600 / size));
    canvas.width = canvas.height = size * scale;
    const g = canvas.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height); g.fillStyle = "#000";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  }

  // ---------- pairing: accept a code (scanned or opened by the phone camera) ----------
  function acceptInvite(text) {
    let inv;
    try { inv = C.parseInvite(text); } catch (e) { toast(e.message); return false; }
    if (inv.key === S.me.publicKey) { toast("That's your own code. Scan the other phone."); return false; }
    let peer = S.peers.find(p => p.key === inv.key);
    if (!peer) { peer = { name: inv.name, key: inv.key, room: inv.room, added: Date.now() }; S.peers.push(peer); }
    else { peer.room = inv.room; }
    save(); connect(peer.room);
    const hello = C.makeHello(S.me);
    if (!sendTo(peer.room, hello)) outbox.push({ room: peer.room, env: hello });
    toast("Paired with " + peer.name);
    openChat(peer);
    return true;
  }

  // ---------- camera scanner ----------
  let stream = null, raf = 0;
  async function startScan() {
    show("scan");
    $("scanStatus").textContent = "Hold the other phone's code inside the square.";
    if (!window.isSecureContext || !navigator.mediaDevices) {
      $("scanStatus").textContent = "The camera needs a secure (https) address. Use the phone's own Camera app on the code instead.";
      return;
    }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); }
    catch (e) { $("scanStatus").textContent = "No camera access. Allow it in Settings, or scan with the phone's own Camera app."; return; }
    const v = $("cam"); v.srcObject = stream; await v.play().catch(() => {});
    const c = $("grab"), g = c.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (!stream) return;
      if (v.readyState >= 2) {
        const w = 480, h = Math.round(480 * v.videoHeight / v.videoWidth) || 480;
        c.width = w; c.height = h; g.drawImage(v, 0, 0, w, h);
        const hit = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
        if (hit && hit.data) { stopCamera(); if (!acceptInvite(hit.data)) setTimeout(startScan, 1500); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function stopCamera() {
    cancelAnimationFrame(raf);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  // ---------- home ----------
  function renderHome() {
    $("meLine").textContent = S.me.name + " · " + C.fingerprint(S.me.publicKey);
    const ul = $("peers"); ul.innerHTML = "";
    const sorted = [...S.peers].sort((a, b) => lastTs(b) - lastTs(a));
    for (const p of sorted) {
      const list = S.msgs[p.key] || [], last = list[list.length - 1];
      const li = document.createElement("li");
      li.innerHTML = `<button><span class="av">${esc(p.name[0] || "?").toUpperCase()}</span><span><span class="name">${esc(p.name)}</span><br><span class="last">${last ? esc((last.mine ? "You: " : "") + (last.sd ? "💥 self-destruct" : last.text)) : "Say hello"}</span></span><span class="when">${last ? hhmm(last.ts) : ""}</span></button>`;
      li.firstChild.onclick = () => openChat(p);
      ul.appendChild(li);
    }
    $("noPeers").hidden = S.peers.length > 0;
  }
  const lastTs = p => { const l = S.msgs[p.key] || []; return l.length ? l[l.length - 1].ts : p.added || 0; };

  // ---------- chat ----------
  let current = null;
  function openChat(peer) {
    current = peer; connect(peer.room);
    $("chatName").textContent = peer.name;
    renderChatState(); renderMsgs();
    if (nav[nav.length - 1] !== "home") nav.splice(0, nav.length, "home");
    show("chat");
  }
  function renderChatState() {
    if (!current) return;
    $("chatState").textContent = (isOnline(current.room) ? "● encrypted · connected" : "○ connecting…") + " · " + C.fingerprint(current.key);
  }
  function renderMsgs() {
    const list = S.msgs[current.key] || [], box = $("msgs");
    box.innerHTML = list.map(m => m.gone
      ? `<div class="gone">— message destroyed —</div>`
      : `<div class="b${m.mine ? " mine" : ""}${m.sd ? " sd" : ""}" data-id="${esc(m.id)}"><div class="s">${esc(m.mine ? S.me.name : current.name)}</div><div class="t">${esc(m.text)}</div><div class="m">${hhmm(m.ts)}${m.sd ? " · 💥 self-destruct" : ""}</div></div>`).join("");
    box.scrollTop = box.scrollHeight;
    // Self-destruct: incoming ones burn 5 seconds after they're on screen, like the desktop app.
    for (const m of list) if (m.sd && !m.mine && !m.gone && !m.burning) {
      m.burning = true;
      const peerKey = current.key;
      setTimeout(() => {
        const el = box.querySelector(`[data-id="${CSS.escape(m.id)}"]`); if (el) el.classList.add("burn");
        setTimeout(() => {
          m.gone = true; m.text = ""; delete m.burning; save();
          if (current && current.key === peerKey) renderMsgs();
        }, 1200);
      }, 5000);
    }
  }
  $("composer").onsubmit = e => {
    e.preventDefault();
    const text = $("text").value.trim(); if (!text || !current) return;
    const sd = $("sd").checked, id = C.b64url(nacl.randomBytes(9)), ts = Date.now();
    const env = C.makeEnvelope(text, S.me, current, { selfDestruct: sd, id, ts });
    if (!sendTo(current.room, env)) { outbox.push({ room: current.room, env }); toast("Offline. It'll send when you're back."); }
    (S.msgs[current.key] ||= []).push({ id, mine: true, text, ts, sd });
    trim(S.msgs[current.key]); save();
    $("text").value = ""; $("sd").checked = false; renderMsgs();
  };
  function trim(list) { if (list.length > 500) list.splice(0, list.length - 500); }

  // ---------- settings ----------
  $("openSettings").onclick = () => {
    $("setName").value = S.me.name; $("setRelay").value = S.relay || ""; $("setFp").textContent = C.fingerprint(S.me.publicKey);
    themePicker($("setThemes"), S.theme, n => { S.theme = n; applyTheme(n); save(); });
    show("settings");
  };
  $("setName").onchange = e => { const v = e.target.value.trim(); if (v) { S.me.name = v; save(); myInvite = null; } };
  $("setRelay").onchange = e => { S.relay = e.target.value.trim(); save(); for (const r of [...socks.keys()]) { disconnect(r); connect(r); } };
  $("wipe").onclick = async () => {
    if (!(await ask("Delete your keys, contacts and every message on this phone? This can't be undone."))) return;
    for (const r of [...socks.keys()]) disconnect(r);
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.replace(location.pathname);
  };

  $("showCode").onclick = () => { enterFull(); showCode(false); };
  $("newCode").onclick = () => showCode(true);
  $("scanCode").onclick = () => { enterFull(); startScan(); };

  // ---------- boot ----------
  function boot() {
    setupFullUI();
    for (const list of Object.values(S.msgs)) for (const m of list) delete m.burning; // a burn interrupted by closing the app restarts
    applyTheme(S.theme);
    for (const p of S.peers) connect(p.room);
    for (const i of S.invites) connect(i.room);
    nav.length = 0; renderHome(); show("home");
    const pending = sessionStorage.getItem("sc-pending-invite") || (location.hash.includes("#pair=") ? location.hash : "");
    if (pending) {
      sessionStorage.removeItem("sc-pending-invite");
      window.history.replaceState(null, "", location.pathname);
      acceptInvite(pending);
    }
  }
  window.addEventListener("hashchange", () => { if (S && location.hash.includes("#pair=")) { const h = location.hash; window.history.replaceState(null, "", location.pathname); acceptInvite(h); } });

  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (S) boot();
  else {
    // Opened from a scanned invite before setting up: remember it, set up, then pair.
    if (location.hash.includes("#pair=")) { sessionStorage.setItem("sc-pending-invite", location.hash); window.history.replaceState(null, "", location.pathname); }
    startSetup();
  }

  // For the end-to-end test only: lets the test read state without touching storage formats.
  self.__sc = { get state() { return S; }, isOnline };
})();
