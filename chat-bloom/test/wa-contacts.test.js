const test = require("node:test");
const assert = require("node:assert");
const C = require("../wa-contacts.js");

const owner = { id: "me", username: "me", name: "Me" };
const freshDb = () => ({ users: [owner], msgs: [] });

test("10-digit Indian numbers get the 91 country code", () => {
  assert.strictEqual(C.normalizePhone("94601 18040"), "919460118040");
  assert.strictEqual(C.normalizePhone("+91 94601 18040"), "919460118040");
  assert.strictEqual(C.normalizePhone("14155552671"), "14155552671");
});

test("a reply that arrives by LID with sender number lands in the existing phone chat", () => {
  const db = freshDb();
  const sent = C.resolveContact(db, { remoteJid: "919460118040@s.whatsapp.net", fromMe: true });
  const reply = C.resolveContact(db, {
    remoteJid: "116076272726180@lid",
    senderPn: "919460118040@s.whatsapp.net",
    fromMe: false,
    pushName: "Pankaj Kalal"
  });
  assert.strictEqual(reply.contact.id, sent.contact.id);
  assert.strictEqual(db.users.filter(u => u.isWhatsApp).length, 1);
  assert.strictEqual(reply.contact.name, "Pankaj Kalal");
});

test("a LID-only chat is merged into the phone chat once the number is learned", () => {
  const db = freshDb();
  const lidChat = C.resolveContact(db, { remoteJid: "116076272726180@lid", fromMe: false, pushName: "Pankaj" }).contact;
  db.msgs.push({ id: "A", from: lidChat.id, to: "me", text: "Hi", t: 1 });
  const phoneChat = C.resolveContact(db, { remoteJid: "919460118040@s.whatsapp.net", fromMe: true }).contact;
  const merges = C.linkLid(db, "116076272726180@lid", "919460118040@s.whatsapp.net");
  assert.deepStrictEqual(merges, [{ fromId: lidChat.id, toId: phoneChat.id }]);
  assert.strictEqual(db.msgs[0].from, phoneChat.id);
  assert.strictEqual(db.users.filter(u => u.isWhatsApp).length, 1);
  // later messages by LID alone now resolve to the same chat
  const later = C.resolveContact(db, { remoteJid: "116076272726180@lid", fromMe: false });
  assert.strictEqual(later.contact.id, phoneChat.id);
});

test("sending to a LID-only contact uses its LID address", () => {
  const db = freshDb();
  const c = C.resolveContact(db, { remoteJid: "116076272726180@lid", fromMe: false }).contact;
  assert.strictEqual(C.jidForContact(c), "116076272726180@lid");
});

test("groups and status updates don't create contacts", () => {
  const db = freshDb();
  assert.strictEqual(C.resolveContact(db, { remoteJid: "120363025@g.us" }), null);
  assert.strictEqual(C.resolveContact(db, { remoteJid: "status@broadcast" }), null);
  assert.strictEqual(db.users.length, 1);
});

test("old data: number saved without 91 is merged and echo duplicates removed", () => {
  const db = {
    users: [
      owner,
      { id: "wa_9460118040", username: "wa_9460118040", name: "+9460118040", isWhatsApp: true, waJid: "9460118040@s.whatsapp.net" },
      { id: "wa_919460118040", username: "wa_919460118040", name: "Hiren Test", isWhatsApp: true, waJid: "919460118040@s.whatsapp.net" }
    ],
    msgs: [
      { id: "11111111-aaaa", from: "me", to: "wa_9460118040", text: "hlo", t: 1794044640811, isWhatsApp: true },
      { id: "3EB0CC3730769FBFBBDECC", from: "me", to: "wa_9460118040", text: "hlo", t: 1794044640000, isWhatsApp: true },
      { id: "3EB0REALREPLY", from: "wa_919460118040", to: "me", text: "hlo", t: 1794044650000, isWhatsApp: true }
    ]
  };
  const r = C.migrateDb(db);
  assert.strictEqual(r.mergedContacts, 1);
  assert.strictEqual(r.removedDuplicates, 1);
  assert.deepStrictEqual(db.users.filter(u => u.isWhatsApp).map(u => u.id), ["wa_919460118040"]);
  assert.ok(db.msgs.every(m => m.from === "me" ? m.to === "wa_919460118040" : m.from === "wa_919460118040"));
  assert.strictEqual(db.msgs.length, 2);
});
