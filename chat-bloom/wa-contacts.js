// Helpers that keep every real WhatsApp person in ONE chat.
//
// WhatsApp can address the same person in two ways:
//   • by phone number  -> 919460118040@s.whatsapp.net
//   • by a private "LID" -> 116076272726180@lid   (newer WhatsApp privacy addressing)
// Older versions of this app treated those as two different people, which is why
// replies from real WhatsApp users opened in a separate "receive-only" chat.
// Everything below is pure (no network) so it can be unit tested.

const WA_COLOR = "linear-gradient(135deg, #25d366, #128c7e)";

// Digits only; 10-digit Indian mobiles (6-9xxxxxxxxx) get the 91 country code.
function normalizePhone(raw) {
  let p = String(raw || "").replace(/[^0-9]/g, "");
  if (p.length === 10 && /^[6-9]/.test(p)) p = "91" + p;
  return p;
}

// Returns { kind: "pn" | "lid" | "other", id }
function classifyJid(jid) {
  const s = String(jid || "");
  if (!s) return { kind: "other", id: "" };
  const at = s.indexOf("@");
  const user = (at >= 0 ? s.slice(0, at) : s).split(":")[0];
  const server = at >= 0 ? s.slice(at + 1) : "s.whatsapp.net";
  if (server === "s.whatsapp.net" || server === "c.us") return { kind: "pn", id: normalizePhone(user) };
  if (server === "lid") return { kind: "lid", id: user.replace(/[^0-9]/g, "") };
  return { kind: "other", id: user };
}

const isPlaceholderName = n => !n || /^\+?[\d\s-]+$/.test(String(n));

function contactPhone(u) {
  if (!u || !u.isWhatsApp) return null;
  const c = classifyJid(u.waJid);
  return c.kind === "pn" && c.id ? c.id : null;
}

function contactLid(u) {
  if (!u || !u.isWhatsApp) return null;
  if (u.waLid) return u.waLid;
  const c = classifyJid(u.waJid);
  return c.kind === "lid" && c.id ? c.id : null;
}

// Contacts that are only known by LID (no phone number yet)
const isLidOnly = u => !!u && u.isWhatsApp && classifyJid(u.waJid).kind === "lid";

const findByPhone = (db, phone) => phone && db.users.find(u => u.isWhatsApp && contactPhone(u) === phone);
const findByLid = (db, lid) => lid && db.users.find(u => u.isWhatsApp && contactLid(u) === lid);
const findLidOnly = (db, lid) => lid && db.users.find(u => isLidOnly(u) && contactLid(u) === lid);

function uniqueId(db, base) {
  let id = base, n = 2;
  while (db.users.some(u => u.id === id || u.username === id)) id = base + "_" + n++;
  return id;
}

function newPhoneContact(db, phone, name) {
  const id = uniqueId(db, "wa_" + phone);
  return {
    id,
    username: id,
    name: name && !isPlaceholderName(name) ? String(name).slice(0, 40) : "+" + phone,
    bio: "WhatsApp (+" + phone + ")",
    color: WA_COLOR,
    isWhatsApp: true,
    waJid: phone + "@s.whatsapp.net",
    online: true
  };
}

function newLidContact(db, lid, name) {
  const id = uniqueId(db, "wa_lid_" + lid);
  return {
    id,
    username: id,
    name: name ? String(name).slice(0, 40) : "WhatsApp user",
    bio: "Real WhatsApp contact (number hidden by WhatsApp)",
    color: WA_COLOR,
    isWhatsApp: true,
    waJid: lid + "@lid",
    waLid: lid,
    online: true
  };
}

// Move every message from one contact into another and remove the duplicate contact.
function mergeContacts(db, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  const from = db.users.find(u => u.id === fromId);
  const to = db.users.find(u => u.id === toId);
  if (!from || !to) return false;

  const move = m => {
    if (m.from === fromId) m.from = toId;
    if (m.to === fromId) m.to = toId;
    if (m.reactions && m.reactions[fromId]) {
      m.reactions[toId] = m.reactions[fromId];
      delete m.reactions[fromId];
    }
  };
  (db.msgs || []).forEach(move);
  (db.scheduledMsgs || []).forEach(move);

  const lid = contactLid(from);
  if (lid && !to.waLid && !isLidOnly(to)) to.waLid = lid;
  if (isPlaceholderName(to.name) && !isPlaceholderName(from.name) && from.name !== "WhatsApp user") to.name = from.name;
  if (!to.avatar && from.avatar) to.avatar = from.avatar;

  const idx = db.users.indexOf(from);
  if (idx >= 0) db.users.splice(idx, 1);
  return true;
}

// Remember that a LID belongs to a phone number; merges a LID-only chat into the phone chat.
// Returns a list of { fromId, toId } merges that happened.
function linkLid(db, lidRaw, phoneRaw) {
  const lid = classifyJid(String(lidRaw).includes("@") ? lidRaw : lidRaw + "@lid").id;
  const phone = classifyJid(String(phoneRaw).includes("@") ? phoneRaw : phoneRaw + "@s.whatsapp.net").id;
  if (!lid || !phone || phone.length < 6) return [];
  db.waLidMap = db.waLidMap || {};
  db.waLidMap[lid] = phone;

  const merges = [];
  const phoneContact = findByPhone(db, phone);
  const lidContact = findLidOnly(db, lid);
  if (phoneContact) {
    if (phoneContact.waLid !== lid) phoneContact.waLid = lid;
    if (lidContact && lidContact.id !== phoneContact.id && mergeContacts(db, lidContact.id, phoneContact.id)) {
      merges.push({ fromId: lidContact.id, toId: phoneContact.id });
    }
  } else if (lidContact) {
    // Upgrade the LID-only chat into a normal phone chat (keeps its id so the open chat stays put)
    lidContact.waJid = phone + "@s.whatsapp.net";
    lidContact.waLid = lid;
    lidContact.bio = "WhatsApp (+" + phone + ")";
    if (lidContact.name === "WhatsApp user") lidContact.name = "+" + phone;
  }
  return merges;
}

/**
 * Find (or create) the single contact for an incoming/outgoing WhatsApp message.
 * Returns null for groups, channels and broadcasts (not supported by this app).
 */
function resolveContact(db, { remoteJid, senderPn, fromMe, pushName }) {
  const c = classifyJid(remoteJid);
  if (c.kind === "other" || !c.id) return null;

  const out = { contact: null, created: false, changed: false, merges: [] };
  let phone = c.kind === "pn" ? c.id : null;
  const lid = c.kind === "lid" ? c.id : null;

  // For messages *we* sent from the phone, sender_pn is our own number, so ignore it.
  if (lid && !phone && !fromMe && senderPn) {
    const s = classifyJid(senderPn);
    if (s.kind === "pn" && s.id) phone = s.id;
  }
  if (lid && !phone && db.waLidMap && db.waLidMap[lid]) phone = db.waLidMap[lid];
  if (lid && !phone) {
    const known = findByLid(db, lid);
    if (known && contactPhone(known)) phone = contactPhone(known);
  }
  if (phone && phone.length < 6) return null;

  if (phone && lid) out.merges = linkLid(db, lid, phone);

  let contact = phone ? findByPhone(db, phone) : findByLid(db, lid);
  if (!contact) {
    contact = phone ? newPhoneContact(db, phone, fromMe ? null : pushName) : newLidContact(db, lid, fromMe ? null : pushName);
    if (lid && phone) contact.waLid = lid;
    db.users.push(contact);
    out.created = true;
  }

  if (!fromMe && pushName && (isPlaceholderName(contact.name) || contact.name === "WhatsApp user") && pushName !== contact.name) {
    contact.name = String(pushName).slice(0, 40);
    out.changed = true;
  }
  out.contact = contact;
  return out;
}

// The address to send to: phone number when known, otherwise the LID.
function jidForContact(u) {
  const p = contactPhone(u);
  if (p) return p + "@s.whatsapp.net";
  const l = contactLid(u);
  if (l) return l + "@lid";
  return u && u.waJid;
}

/**
 * One-time clean-up of data saved by older versions:
 *  - numbers saved without country code (9460118040) are merged into 919460118040
 *  - duplicate copies of messages you sent (the WhatsApp "echo") are removed
 */
function migrateDb(db) {
  const report = { mergedContacts: 0, removedDuplicates: 0 };
  db.users = db.users || [];
  db.msgs = db.msgs || [];

  const groups = {};
  for (const u of db.users) {
    if (!u.isWhatsApp) continue;
    const c = classifyJid(u.waJid);
    if (c.kind !== "pn" || !c.id) continue;
    u.waJid = c.id + "@s.whatsapp.net";
    (groups[c.id] = groups[c.id] || []).push(u);
  }
  for (const [phone, list] of Object.entries(groups)) {
    if (list.length < 2) continue;
    const target =
      list.find(u => u.id === "wa_" + phone) || list.find(u => !isPlaceholderName(u.name)) || list[0];
    for (const u of list) {
      if (u !== target && mergeContacts(db, u.id, target.id)) report.mergedContacts++;
    }
  }
  if (db.waLidMap) {
    for (const [lid, phone] of Object.entries(db.waLidMap)) {
      report.mergedContacts += linkLid(db, lid, phone).length;
    }
  }

  // Messages that never left (WhatsApp was disconnected) are shown as "not sent"
  for (const m of db.msgs) {
    if (m.isWhatsApp && m.error && m.status !== "failed" && !m.deleted) m.status = "failed";
  }

  // Remove WhatsApp echoes of messages that were sent from this app
  const appSent = db.msgs.filter(m => m.isWhatsApp && String(m.id).includes("-"));
  const before = db.msgs.length;
  db.msgs = db.msgs.filter(m => {
    if (!m.isWhatsApp || String(m.id).includes("-")) return true;
    return !appSent.some(
      a => a.from === m.from && a.to === m.to && (a.text || "") === (m.text || "") && Math.abs(a.t - m.t) < 5000
    );
  });
  report.removedDuplicates = before - db.msgs.length;
  return report;
}

module.exports = {
  WA_COLOR,
  normalizePhone,
  classifyJid,
  contactPhone,
  contactLid,
  isLidOnly,
  isPlaceholderName,
  findByPhone,
  findByLid,
  mergeContacts,
  linkLid,
  resolveContact,
  jidForContact,
  migrateDb
};
