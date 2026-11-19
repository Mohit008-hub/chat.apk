// End-to-end check of the app-to-app features with two real accounts.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { io } = require("socket.io-client");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `cbm-test-${PORT}.json`);
let server;

const post = (p, body, token) =>
  fetch(BASE + "/api/" + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body)
  }).then(r => r.json());
const get = (p, token) => fetch(BASE + "/api/" + p, { headers: { Authorization: "Bearer " + token } }).then(r => r.json());
const once = (sock, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting for " + ev)), ms);
    sock.once(ev, d => (clearTimeout(t), res(d)));
  });
const connect = token =>
  new Promise(res => {
    const s = io(BASE, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => res(s));
  });

let A, B, sa, sb;

test.before(async () => {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify({
      users: [{ id: "wa_919460118040", username: "wa_919460118040", name: "Hiren", isWhatsApp: true, waJid: "919460118040@s.whatsapp.net" }],
      msgs: []
    })
  );
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + "/api/users");
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  A = await post("register", { username: "alice", name: "Alice", password: "secret1" });
  B = await post("register", { username: "bob", name: "Bob", password: "secret1" });
  sa = await connect(A.token);
  sb = await connect(B.token);
});

test.after(() => {
  sa?.close();
  sb?.close();
  server?.kill();
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test("opening someone's chat notifies them with your name", async () => {
  const p = once(sb, "chat_viewed_by");
  sa.emit("chat_viewing", { to: B.user.id });
  const d = await p;
  assert.strictEqual(d.name, "Alice");
  assert.strictEqual(d.by, A.user.id);
});

test("the other person sees your draft while you type", async () => {
  const p = once(sb, "typing");
  sa.emit("typing", { to: B.user.id, typing: true, draft: "see you at 5" });
  const d = await p;
  assert.strictEqual(d.draft, "see you at 5");
});

test("a message deleted by the sender stays readable for the recipient", async () => {
  const got = once(sb, "message");
  const sent = await new Promise(r => sa.emit("send_message", { to: B.user.id, text: "oops secret" }, r));
  await got;
  const revoked = once(sb, "message_revoked");
  const ack = await new Promise(r => sa.emit("delete_message", { msgId: sent.m.id, to: B.user.id }, r));
  assert.ok(ack.ok);
  assert.strictEqual((await revoked).originalText, "oops secret");
  // after a refresh too
  const bobView = (await get("messages/" + A.user.id, B.token)).find(m => m.id === sent.m.id);
  assert.strictEqual(bobView.text, "oops secret");
  assert.strictEqual(bobView.wasRevoked, true);
  const aliceView = (await get("messages/" + B.user.id, A.token)).find(m => m.id === sent.m.id);
  assert.strictEqual(aliceView.deleted, true);
  assert.strictEqual(aliceView.text, "This message was deleted");
});

test("someone else can't delete your message", async () => {
  const sent = await new Promise(r => sa.emit("send_message", { to: B.user.id, text: "mine" }, r));
  const ack = await new Promise(r => sb.emit("delete_message", { msgId: sent.m.id, to: A.user.id }, r));
  assert.ok(ack.error);
});

test("real WhatsApp contacts are only visible to the account that linked WhatsApp", async () => {
  // Alice is the first account, so she owns the WhatsApp link by default
  const aliceUsers = await get("users", A.token);
  const bobUsers = await get("users", B.token);
  assert.ok(aliceUsers.some(u => u.id === "wa_919460118040"));
  assert.ok(!bobUsers.some(u => u.id === "wa_919460118040"));
  const ack = await new Promise(r => sb.emit("send_message", { to: "wa_919460118040", text: "hi" }, r));
  assert.ok(ack.error);
});

test("disappearing messages are removed when the timer ends", async () => {
  const sent = await new Promise(r => sa.emit("send_message", { to: B.user.id, text: "poof", disappearingDuration: 1000 }, r));
  const gone = await once(sb, "message_expired", 4000);
  assert.strictEqual(gone.msgId, sent.m.id);
  const list = await get("messages/" + A.user.id, B.token);
  assert.ok(!list.some(m => m.id === sent.m.id));
});
