/*
 * Chat Bloom — WhatsApp Integration
 * Connects your WhatsApp directly to Chat Bloom without needing any server key.
 * Simply run `npm start` and scan the QR code from the web interface!
 */
const fs = require("fs");
const path = require("path");

// --- read .env (no extra packages needed) ---
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SITE = String(process.env.CHAT_BLOOM_URL || "").replace(/\/+$/, "");
const KEY = String(process.env.CHAT_BLOOM_KEY || "");

const wa = require("./whatsapp");
const C = require("./wa-contacts");

const OWNER = "owner";
const DATA_FILE = process.env.BRIDGE_DATA_FILE || path.join(__dirname, "bridge-data.json");
let db = { users: [{ id: OWNER, username: "owner", name: "Me" }], msgs: [], waOwnerId: OWNER };
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
} catch (e) {
  console.warn("Couldn't read bridge-data.json, starting fresh:", e.message);
}
if (!db.users.some(u => u.id === OWNER)) db.users.unshift({ id: OWNER, username: "owner", name: "Me" });
db.waOwnerId = OWNER;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (db.msgs.length > 5000) db.msgs = db.msgs.slice(-5000);
    // Images are already stored on the website; keep this file small
    const slim = { ...db, msgs: db.msgs.map(m => (m.media ? { ...m, media: { type: m.media.type } } : m)) };
    fs.writeFileSync(DATA_FILE, JSON.stringify(slim));
  }, 300);
}

/* ---------- events going to the website ---------- */
const outbox = [];
const push = ev => {
  if (ev.type === "status") {
    const i = outbox.findIndex(e => e.type === "status");
    if (i >= 0) outbox.splice(i, 1);
  }
  outbox.push(ev);
};

const fakeIo = {
  emit(event, data) {
    if (event === "wa_status_update") push({ type: "status", ...data });
  }
};

function emitTo(_userId, event, d) {
  switch (event) {
    case "message": {
      const { silent, ...m } = d;
      return push({ type: "message", m });
    }
    case "user_updated":
      return push({ type: "contact", user: d });
    case "user_merged":
      return push({ type: "merge", fromId: d.fromId, toId: d.toId, user: d.user });
    case "message_revoked":
    case "message_deleted":
      return push({ type: "revoke", msgId: d.msgId });
    case "message_edited":
      return push({ type: "edit", msgId: d.msgId, text: d.text });
    case "message_reaction":
      return push({ type: "reaction", msgId: d.msgId, reactions: d.reactions });
    case "msg_status":
      return push({ type: "msg_status", id: d.id, status: d.status });
    case "typing":
      return push({ type: "typing", from: d.from, typing: d.typing });
    case "chat_viewed_by":
      return push({ type: "viewed", ...d });
    case "wa_presence":
      return push({ type: "wa_presence", id: d.id, online: d.online });
    case "wa_connected":
      return push({ type: "status", ...wa.getStatus() });
  }
}

wa.initWhatsApp(fakeIo, db, save, { emitTo, pub: u => ({ ...u }), autoConnect: require.main === module });

/* ---------- actions coming from the website ---------- */
function ensureContact(id, waJid, name) {
  let c = db.users.find(u => u.id === id);
  if (c) return c;
  const phone = C.normalizePhone((waJid || "").split("@")[0] || String(id).replace(/^wa_/, "").split("_")[0]);
  const byPhone = phone ? C.findByPhone(db, phone) : null;
  if (byPhone) {
    // The website knows this person under another id: tell it to merge into ours
    push({ type: "merge", fromId: id, toId: byPhone.id, user: byPhone });
    return byPhone;
  }
  if (!phone || phone.length < 8) return null;
  c = {
    id,
    username: id,
    name: name || "+" + phone,
    bio: "WhatsApp (+" + phone + ")",
    color: "linear-gradient(135deg, #25d366, #128c7e)",
    isWhatsApp: true,
    waJid: phone + "@s.whatsapp.net",
    online: true
  };
  db.users.push(c);
  save();
  return c;
}

async function mediaToDataUrl(media) {
  if (!media || !media.url) return media || null;
  const r = await fetch(media.url);
  if (!r.ok) throw new Error("Couldn't load the photo to send");
  const type = r.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await r.arrayBuffer());
  return { type: "image", data: `data:${type};base64,${buf.toString("base64")}` };
}

async function handle(a) {
  switch (a.kind) {
    case "connect":
      return wa.connectToWhatsApp(true);
    case "logout":
      return wa.logoutWhatsApp();
    case "contact": {
      const c = ensureContact(a.id, a.waJid, a.name);
      if (c) wa.subscribePresence(c);
      return;
    }
    case "send": {
      const contact = ensureContact(a.to);
      if (!contact) return push({ type: "send_result", id: a.id, ok: false, error: "Unknown WhatsApp contact" });
      const local = { id: a.id, from: OWNER, to: contact.id, text: a.text || "", media: null, t: Date.now(), status: "sent", isWhatsApp: true, reactions: {} };
      if (!db.msgs.some(m => m.id === a.id)) db.msgs.push(local); // so WhatsApp's echo isn't saved twice
      try {
        const media = a.media ? await mediaToDataUrl(a.media) : null;
        const res = await wa.sendWhatsAppMessage(contact, { text: a.text || "", media, id: a.id });
        local.waRemoteJid = res.jid;
        const saved = db.msgs.find(m => m.id === a.id);
        if (saved) saved.waRemoteJid = res.jid;
        save();
        push({ type: "send_result", id: a.id, ok: true, jid: res.jid });
      } catch (e) {
        push({ type: "send_result", id: a.id, ok: false, error: e.message });
      }
      return;
    }
    case "revoke": {
      const contact = ensureContact(a.to);
      const msg = db.msgs.find(m => m.id === a.id) || { id: a.id, from: OWNER, waRemoteJid: a.remoteJid };
      msg.deleted = true;
      msg.deletedBy = OWNER;
      save();
      return wa.revokeWhatsAppMessage({ ...msg, waRemoteJid: msg.waRemoteJid || a.remoteJid }, contact).catch(e => console.warn("Delete on WhatsApp failed:", e.message));
    }
    case "react": {
      const contact = ensureContact(a.to);
      const msg = { id: a.id, from: a.fromMe ? OWNER : a.to, waRemoteJid: a.remoteJid };
      return wa.reactWhatsAppMessage(msg, contact, a.emoji, OWNER).catch(e => console.warn("Reaction failed:", e.message));
    }
    case "read":
      return wa.markRead((a.keys || []).map(k => ({ id: k.id, waRemoteJid: k.remoteJid, isWhatsApp: true })));
    case "typing": {
      const c = ensureContact(a.to);
      if (c) wa.sendTyping(c, !!a.typing);
      return;
    }
    case "presence": {
      const c = ensureContact(a.to);
      if (c) wa.subscribePresence(c);
      return;
    }
  }
}

/* ---------- talk to the website ---------- */
let failures = 0;
async function tick() {
  const events = outbox.splice(0, 20);
  let actions = [];
  try {
    const r = await fetch(SITE + "/api/public/wa-bridge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-key": KEY },
      body: JSON.stringify({ events })
    });
    if (r.status === 401) {
      console.error("The website rejected the server key. Make a new one (Link WhatsApp → New server key) and update .env.");
      outbox.unshift(...events);
      return setTimeout(tick, 15000);
    }
    if (!r.ok) throw new Error(`Website answered ${r.status}`);
    const body = await r.json();
    actions = body.actions || [];
    if (body.errors && body.errors.length) console.warn("Website couldn't apply:", body.errors.join("; "));
    if (failures) console.log("Back online with the website ✓");
    failures = 0;
  } catch (e) {
    outbox.unshift(...events);
    if (failures++ % 10 === 0) console.warn("Can't reach the website:", e.message);
  }
  for (const a of actions) {
    try {
      await handle(a);
    } catch (e) {
      console.warn(`Action ${a.kind} failed:`, e.message);
    }
  }
  setTimeout(tick, outbox.length || actions.length ? 250 : 1500);
}

if (require.main === module) {
  if (SITE && KEY) {
    console.log("Chat Bloom bridge started (remote mode) →", SITE);
    push({ type: "status", ...wa.getStatus() });
    tick();
  } else {
    console.log("Chat Bloom running with direct WhatsApp linking (no server key needed)...");
    require("./server.js");
  }
}

module.exports = { emitTo, handle, outbox, db };
