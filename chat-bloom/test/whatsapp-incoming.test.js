const test = require("node:test");
const assert = require("node:assert");
const wa = require("../whatsapp.js");

function setup() {
  const db = {
    users: [{ id: "me", username: "me", name: "Me" }, { id: "other", username: "other", name: "Other app user" }],
    msgs: [],
    waOwnerId: "me"
  };
  const events = [];
  wa.initWhatsApp(null, db, () => {}, { emitTo: (id, e, d) => events.push({ id, e, d }), autoConnect: false });
  return { db, events };
}

const textMsg = (id, remoteJid, text, extra = {}) => ({
  key: { id, remoteJid, fromMe: false, ...extra },
  pushName: "Pankaj Kalal",
  messageTimestamp: 1794045223,
  message: { conversation: text }
});

test("incoming WhatsApp messages only go to the account that linked WhatsApp", async () => {
  const { events } = setup();
  await wa._handleUpsert({ type: "notify", messages: [textMsg("M1", "919460118040@s.whatsapp.net", "Hi")] });
  assert.ok(events.length > 0);
  assert.ok(events.every(ev => ev.id === "me"));
});

test("a reply sent via LID goes into the same chat as messages sent to the number", async () => {
  const { db } = setup();
  await wa._handleUpsert({
    type: "notify",
    messages: [{ key: { id: "OUT1", remoteJid: "919460118040@s.whatsapp.net", fromMe: true }, message: { conversation: "hlo" } }]
  });
  await wa._handleUpsert({
    type: "notify",
    messages: [textMsg("IN1", "116076272726180@lid", "Hi", { senderPn: "919460118040@s.whatsapp.net" })]
  });
  const out = db.msgs.find(m => m.id === "OUT1");
  const inc = db.msgs.find(m => m.id === "IN1");
  assert.strictEqual(inc.from, out.to);
  assert.strictEqual(db.users.filter(u => u.isWhatsApp).length, 1);
});

test("delete-for-everyone from WhatsApp keeps the original text (anti-delete)", async () => {
  const { db, events } = setup();
  await wa._handleUpsert({ type: "notify", messages: [textMsg("M2", "919460118040@s.whatsapp.net", "secret")] });
  await wa._handleUpsert({
    type: "notify",
    messages: [{
      key: { id: "REV", remoteJid: "919460118040@s.whatsapp.net", fromMe: false },
      message: { protocolMessage: { type: 0, key: { id: "M2", remoteJid: "919460118040@s.whatsapp.net" } } }
    }]
  });
  const m = db.msgs.find(x => x.id === "M2");
  assert.strictEqual(m.text, "secret");
  assert.strictEqual(m.deleted, true);
  const ev = events.find(e => e.e === "message_revoked");
  assert.strictEqual(ev.d.originalText, "secret");
});

test("the WhatsApp echo of a message sent from the app is not saved twice", async () => {
  const { db } = setup();
  await wa._handleUpsert({ type: "notify", messages: [textMsg("SAME", "919460118040@s.whatsapp.net", "one")] });
  await wa._handleUpsert({ type: "notify", messages: [textMsg("SAME", "919460118040@s.whatsapp.net", "one")] });
  assert.strictEqual(db.msgs.filter(m => m.id === "SAME").length, 1);
});

test("blue ticks from WhatsApp mark the message read and raise an 'opened your chat' alert", async () => {
  const { db, events } = setup();
  await wa._handleUpsert({
    type: "notify",
    messages: [{ key: { id: "OUT2", remoteJid: "919460118040@s.whatsapp.net", fromMe: true }, message: { conversation: "hey" } }]
  });
  wa._handleUpdates([{ key: { id: "OUT2", remoteJid: "919460118040@s.whatsapp.net", fromMe: true }, update: { status: 4 } }]);
  assert.strictEqual(db.msgs.find(m => m.id === "OUT2").status, "read");
  const alert = events.find(e => e.e === "chat_viewed_by");
  assert.strictEqual(alert.d.phone, "919460118040");
  assert.strictEqual(alert.d.reason, "read");
});
