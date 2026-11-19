const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
process.env.BRIDGE_DATA_FILE = path.join(os.tmpdir(), `bridge-test-${process.pid}-${Date.now()}.json`);
const wa = require("../whatsapp.js");
const bridge = require("../bridge.js");

const take = () => bridge.outbox.splice(0, bridge.outbox.length);

test("an incoming WhatsApp message is forwarded to the website", async () => {
  take();
  await wa._handleUpsert({
    type: "notify",
    messages: [{ key: { id: "BR1", remoteJid: "919460118040@s.whatsapp.net", fromMe: false }, pushName: "Pankaj", messageTimestamp: 1794045223, message: { conversation: "Hi from WhatsApp" } }]
  });
  const out = take();
  const msg = out.find(e => e.type === "message");
  assert.ok(msg, "message event sent");
  assert.strictEqual(msg.m.text, "Hi from WhatsApp");
  assert.strictEqual(msg.m.to, "owner");
  assert.ok(out.some(e => e.type === "contact" && e.user.waJid === "919460118040@s.whatsapp.net"));
});

test("a reply via LID stays in the same chat on the website", async () => {
  take();
  await wa._handleUpsert({
    type: "notify",
    messages: [{ key: { id: "BR2", remoteJid: "116076272726180@lid", fromMe: false, senderPn: "919460118040@s.whatsapp.net" }, pushName: "Pankaj", message: { conversation: "reply" } }]
  });
  const out = take();
  const first = bridge.db.msgs.find(m => m.id === "BR1");
  const msg = out.find(e => e.type === "message");
  assert.strictEqual(msg.m.from, first.from);
});

test("delete-for-everyone on WhatsApp is forwarded so the website keeps the original", async () => {
  take();
  await wa._handleUpsert({
    type: "notify",
    messages: [{ key: { id: "REVX", remoteJid: "919460118040@s.whatsapp.net", fromMe: false }, message: { protocolMessage: { type: 0, key: { id: "BR1", remoteJid: "919460118040@s.whatsapp.net" } } } }]
  });
  assert.ok(take().some(e => e.type === "revoke" && e.msgId === "BR1"));
});

test("sending fails cleanly when WhatsApp isn't linked yet", async () => {
  take();
  await bridge.handle({ kind: "send", id: "3EB0TEST", to: "wa_919460118040", text: "hello" });
  const res = take().find(e => e.type === "send_result");
  assert.strictEqual(res.ok, false);
});
