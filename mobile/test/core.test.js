const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const C = require("../js/core.js");

test("seal/open round trip, and tampering or the wrong key fails", () => {
  const a = C.newIdentity("Alice"), b = C.newIdentity("Bob"), eve = C.newIdentity("Eve");
  const sealed = C.seal("Package is at the drop.", a.secretKey, b.publicKey);
  assert.equal(C.open(sealed, b.secretKey, a.publicKey), "Package is at the drop.");
  assert.equal(C.open(sealed, eve.secretKey, a.publicKey), null, "someone else can't read it");
  const raw = C.unb64(sealed); raw[raw.length - 1] ^= 1;
  assert.equal(C.open(C.b64(raw), b.secretKey, a.publicKey), null, "a flipped bit is rejected");
  assert.equal(C.open("not base64!!", b.secretKey, a.publicKey), null);
});

test("invites: link round trip, and bad invites are refused", () => {
  const me = C.newIdentity("Maya ✨");
  const inv = C.newInvite(me);
  const link = C.inviteLink("https://securechat.example/app/", inv);
  assert.match(link, /^https:\/\/securechat\.example\/app\/#pair=[A-Za-z0-9_-]+$/);
  assert.deepEqual(C.parseInvite(link), { name: "Maya ✨", key: me.publicKey, room: inv.r });
  assert.throws(() => C.parseInvite("https://example.com"), /isn't a SecureChat invite/);
  assert.throws(() => C.parseInvite("#pair=AAAA"), /damaged/);
  const bad = C.b64url(new TextEncoder().encode(JSON.stringify({ v: 1, n: "x", k: "c2hvcnQ=", r: inv.r })));
  assert.throws(() => C.parseInvite("#pair=" + bad), /valid key/);
});

test("envelopes: only paired peers are read, and forged senders are rejected", () => {
  const a = C.newIdentity("A"), b = C.newIdentity("B"), eve = C.newIdentity("Eve");
  const env = C.makeEnvelope("hi", a, { key: b.publicKey }, { selfDestruct: true, id: "x1", ts: 5 });
  assert.equal(env.from, a.publicKey);
  const got = C.readEnvelope(env, b, [{ name: "A", key: a.publicKey }]);
  assert.equal(got.text, "hi"); assert.equal(got.selfDestruct, true); assert.equal(got.id, "x1");
  assert.equal(C.readEnvelope(env, b, []), null, "unknown sender ignored");
  const forged = { ...env, from: eve.publicKey };
  assert.equal(C.readEnvelope(forged, b, [{ name: "Eve", key: eve.publicKey }]), null, "can't pretend to be A");
});

test("hello and fingerprints", () => {
  const me = C.newIdentity("Sam");
  assert.deepEqual(C.readHello(C.makeHello(me)), { name: "Sam", key: me.publicKey });
  assert.equal(C.readHello({ t: "hello", from: "nope" }), null);
  assert.match(C.fingerprint(me.publicKey), /^[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}$/);
  assert.equal(C.fingerprint(me.publicKey), C.fingerprint(me.publicKey));
});

// Desktop compatibility: the phone and the desktop app must read each other's messages.
const PY = process.env.SECURECHAT_PYTHON || "python3";
let havePyNaCl = false;
try { execFileSync(PY, ["-c", "import nacl"], { stdio: "ignore" }); havePyNaCl = true; } catch (e) {}

test("interop with the desktop app's PyNaCl format, both directions", { skip: !havePyNaCl && "PyNaCl not installed" }, () => {
  const phone = C.newIdentity("Phone");
  const py = `
import sys, base64, nacl.public
mode, my_sk, their_pk, data = sys.argv[1:5]
box = nacl.public.Box(nacl.public.PrivateKey(base64.b64decode(my_sk)), nacl.public.PublicKey(base64.b64decode(their_pk)))
if mode == "keypair":
    k = nacl.public.PrivateKey.generate(); print(base64.b64encode(bytes(k)).decode(), base64.b64encode(bytes(k.public_key)).decode())
elif mode == "dec":
    print(box.decrypt(base64.b64decode(data)).decode(), end="")
else:
    print(base64.b64encode(box.encrypt(data.encode())).decode(), end="")
`;
  const run = (...a) => execFileSync(PY, ["-c", py, ...a]).toString();
  const [deskSk, deskPk] = run("keypair", phone.secretKey, phone.publicKey, "").trim().split(" ");
  // phone -> desktop
  const toDesk = C.seal("Burn this after reading. Éire ✓", phone.secretKey, deskPk);
  assert.equal(run("dec", deskSk, phone.publicKey, toDesk), "Burn this after reading. Éire ✓");
  // desktop -> phone
  const toPhone = run("enc", deskSk, phone.publicKey, "Copy. Who else knows?");
  assert.equal(C.open(toPhone, phone.secretKey, deskPk), "Copy. Who else knows?");
});
