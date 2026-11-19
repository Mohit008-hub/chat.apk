const baileys = require("@whiskeysockets/baileys");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  downloadMediaMessage,
  generateMessageIDV2,
  generateMessageID
} = baileys;
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pino = require("pino");
const C = require("./wa-contacts.js");

const os = require("os");
const isVercel = !!process.env.VERCEL;
const defaultAuthDir = path.join(__dirname, "wa_auth");
const tmpAuthDir = path.join(os.tmpdir(), "chat-bloom-wa-auth");
let AUTH_DIR = process.env.WA_AUTH_DIR || (isVercel ? tmpAuthDir : defaultAuthDir);
const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
const logger = pino({ level: "silent" });

let waSocket = null;
let currentQR = null;
let connectionStatus = "disconnected"; // "disconnected" | "connecting" | "qr_ready" | "connected"
let connectedUser = null;
let ioInstance = null;
let dbRef = null;
let saveDbRef = null;
let emitToUser = null;
let pubFn = u => u;
let reconnectTimer = null;

const presenceSubscribed = new Set();
const lastTypingSent = {};
const lastViewNotice = {};

/* ---------------- owner (the app account that linked WhatsApp) ---------------- */

function setOwnerUserId(uid) {
  if (!uid || !dbRef) return;
  const u = dbRef.users.find(x => x.id === uid);
  if (!u || u.isAI || u.isWhatsApp) return;
  if (dbRef.waOwnerId !== uid) {
    dbRef.waOwnerId = uid;
    saveDbRef?.();
  }
}

function getOwnerUserId() {
  if (dbRef?.waOwnerId && dbRef.users.some(u => u.id === dbRef.waOwnerId)) return dbRef.waOwnerId;
  const human = dbRef?.users?.find(u => !u.isAI && !u.isWhatsApp);
  return human ? human.id : null;
}

// Only the owner receives their real WhatsApp messages (other app accounts must not see them)
function emitOwner(event, data) {
  const owner = getOwnerUserId();
  if (owner && emitToUser) emitToUser(owner, event, data);
}

function initWhatsApp(io, db, saveDb, opts = {}) {
  ioInstance = io;
  dbRef = db;
  saveDbRef = saveDb;
  emitToUser = opts.emitTo || null;
  if (opts.pub) pubFn = opts.pub;

  const report = C.migrateDb(db);
  if (report.mergedContacts || report.removedDuplicates) {
    console.log(
      `WhatsApp data clean-up: merged ${report.mergedContacts} duplicate chat(s), removed ${report.removedDuplicates} duplicate message(s).`
    );
    saveDb();
  }

  // Automatically connect / prepare WhatsApp QR code whenever the server is running (no server key needed)
  if (opts.autoConnect !== false) {
    setTimeout(() => connectToWhatsApp().catch(() => {}), 500);
  }
}

function getStatus() {
  return { status: connectionStatus, qr: currentQR, user: connectedUser };
}

/* ---------------- connection ---------------- */

async function connectToWhatsApp(force = false) {
  if (!force && waSocket && ["connected", "qr_ready", "connecting"].includes(connectionStatus)) {
    return getStatus();
  }
  clearTimeout(reconnectTimer);

  if (waSocket) {
    try {
      waSocket.end();
    } catch {}
    waSocket = null;
  }

  connectionStatus = "connecting";
  currentQR = null;
  presenceSubscribed.clear();
  ioInstance?.emit("wa_status_update", getStatus());

  try {
    if (!fs.existsSync(AUTH_DIR)) {
      try {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      } catch (err) {
        if ((err.code === "EROFS" || err.code === "EACCES") && AUTH_DIR !== tmpAuthDir) {
          AUTH_DIR = tmpAuthDir;
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } else {
          throw err;
        }
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["Chat Bloom Moments", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false // keep notifications arriving on your phone
    });
    waSocket = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
      if (sock !== waSocket) return; // an old socket
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQR = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
          connectionStatus = "qr_ready";
          console.log("⚡ WhatsApp QR Code is ready! Scan it in the web interface to link your WhatsApp.");
          ioInstance?.emit("wa_status_update", getStatus());
        } catch (err) {
          console.error("QR Code generation error:", err);
        }
      }

      if (connection === "open") {
        connectionStatus = "connected";
        currentQR = null;
        connectedUser = {
          id: sock.user.id,
          name: sock.user.name || "My WhatsApp",
          phone: sock.user.id.split(":")[0].split("@")[0]
        };
        console.log("Real WhatsApp connected successfully as:", connectedUser.phone);
        ioInstance?.emit("wa_status_update", getStatus());
        emitOwner("wa_connected", connectedUser);
        syncLids().catch(() => {});
      } else if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        console.log("WhatsApp connection closed. Status code:", statusCode, "isLoggedOut:", isLoggedOut);

        connectionStatus = "disconnected";
        currentQR = null;
        connectedUser = null;
        waSocket = null;

        if (isLoggedOut) {
          try {
            if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
          ioInstance?.emit("wa_status_update", getStatus());
          reconnectTimer = setTimeout(() => connectToWhatsApp(true), 1000);
          return;
        }

        ioInstance?.emit("wa_status_update", getStatus());
        if (statusCode !== 408) reconnectTimer = setTimeout(() => connectToWhatsApp(), 3000);
      }
    });

    sock.ev.on("messages.upsert", ev => handleUpsert(ev).catch(err => console.error("WhatsApp message error:", err)));
    sock.ev.on("messages.update", updates => handleUpdates(updates));
    sock.ev.on("presence.update", p => handlePresence(p));
    sock.ev.on("contacts.upsert", list => handleContacts(list));
    sock.ev.on("contacts.update", list => handleContacts(list));
    sock.ev.on("chats.phoneNumberShare", ({ lid, jid }) => applyMerges(C.linkLid(dbRef, lid, jid)));
  } catch (err) {
    console.error("Failed to connect to WhatsApp:", err);
    connectionStatus = "disconnected";
    ioInstance?.emit("wa_status_update", getStatus());
  }

  return getStatus();
}

/* ---------------- contacts / LID linking ---------------- */

function applyMerges(merges) {
  if (!merges || !merges.length) return;
  saveDbRef?.();
  for (const { fromId, toId } of merges) {
    const to = dbRef.users.find(u => u.id === toId);
    emitOwner("user_merged", { fromId, toId, user: to ? pubFn(to) : null });
  }
}

function handleContacts(list) {
  if (!Array.isArray(list)) return;
  let changed = false;
  for (const c of list) {
    if (!c || !c.id) continue;
    const id = C.classifyJid(c.id);
    if (id.kind === "pn" && c.lid) applyMerges(C.linkLid(dbRef, c.lid, c.id));
    if (id.kind === "lid" && c.jid) applyMerges(C.linkLid(dbRef, c.id, c.jid));
    const contact = id.kind === "pn" ? C.findByPhone(dbRef, id.id) : C.findByLid(dbRef, id.id);
    const nm = c.name || c.notify || c.verifiedName;
    if (contact && nm && (C.isPlaceholderName(contact.name) || contact.name === "WhatsApp user")) {
      contact.name = String(nm).slice(0, 40);
      changed = true;
      emitOwner("user_updated", pubFn(contact));
    }
  }
  if (changed) saveDbRef?.();
}

// Ask WhatsApp for the LID of each phone contact so replies land in the same chat
async function lookupLid(contact) {
  if (!waSocket || connectionStatus !== "connected" || !contact || contact.waLid) return;
  const phone = C.contactPhone(contact);
  if (!phone) return;
  try {
    const res = await waSocket.onWhatsApp(phone + "@s.whatsapp.net");
    const hit = (res || []).find(r => r.exists);
    if (hit && hit.lid) applyMerges(C.linkLid(dbRef, hit.lid, phone));
    if (hit && hit.lid) saveDbRef?.();
  } catch {}
}

async function syncLids() {
  const todo = dbRef.users.filter(u => u.isWhatsApp && C.contactPhone(u) && !u.waLid).slice(0, 100);
  for (const u of todo) {
    await lookupLid(u);
    await new Promise(r => setTimeout(r, 250));
  }
}

function subscribePresence(contact) {
  if (!waSocket || connectionStatus !== "connected" || !contact) return;
  const jid = C.jidForContact(contact);
  if (!jid || presenceSubscribed.has(jid)) return;
  presenceSubscribed.add(jid);
  waSocket.presenceSubscribe(jid).catch(() => presenceSubscribed.delete(jid));
  lookupLid(contact);
}

function contactForJid(jid) {
  const c = C.classifyJid(jid);
  if (c.kind === "pn") return C.findByPhone(dbRef, c.id);
  if (c.kind === "lid") {
    const phone = dbRef.waLidMap && dbRef.waLidMap[c.id];
    return (phone && C.findByPhone(dbRef, phone)) || C.findByLid(dbRef, c.id);
  }
  return null;
}

/* ---------------- "who opened my chat" signal from real WhatsApp ---------------- */
// Real WhatsApp never tells anyone that a chat was opened. The closest real signals are:
//   • they READ your messages (blue ticks)       • they start TYPING to you
function notifyOpened(contact, reason) {
  const now = Date.now();
  if (lastViewNotice[contact.id] && now - lastViewNotice[contact.id] < 20000) return;
  lastViewNotice[contact.id] = now;
  emitOwner("chat_viewed_by", {
    by: contact.id,
    name: contact.name,
    username: contact.username,
    phone: C.contactPhone(contact),
    avatar: contact.avatar || null,
    color: contact.color,
    reason,
    t: now
  });
}

/* ---------------- incoming events ---------------- */

const STATUS_RANK = { failed: -1, scheduled: 0, sent: 1, delivered: 2, read: 3 };
const statusFromWa = s => (s >= 4 ? "read" : s === 3 ? "delivered" : s === 2 ? "sent" : null);

function textOf(content) {
  if (!content) return "";
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ""
  );
}

function describe(content) {
  if (content.imageMessage) return "";
  if (content.videoMessage) return "🎥 Video";
  if (content.audioMessage) return "🎤 Voice message";
  if (content.stickerMessage) return "🏷️ Sticker";
  if (content.documentMessage) return "📄 " + (content.documentMessage.fileName || "Document");
  if (content.contactMessage || content.contactsArrayMessage) return "👤 Contact";
  if (content.locationMessage || content.liveLocationMessage) return "📍 Location";
  if (content.pollCreationMessage || content.pollCreationMessageV3) return "📊 Poll";
  return "";
}

function partnerOf(msg) {
  const owner = getOwnerUserId();
  return msg.from === owner ? msg.to : msg.from;
}

function handleRevoke(targetId) {
  const msg = dbRef.msgs.find(x => x.id === targetId);
  if (!msg || msg.deleted) return;
  const owner = getOwnerUserId();
  msg.deleted = true;
  msg.deletedBy = msg.from;
  msg.deletedAt = Date.now();
  saveDbRef?.();
  if (msg.from === owner) {
    emitOwner("message_deleted", { msgId: msg.id, partnerId: msg.to });
  } else {
    // Anti-Delete: the original stays on your side
    emitOwner("message_revoked", {
      msgId: msg.id,
      deletedBy: msg.from,
      originalText: msg.text,
      originalMedia: msg.media,
      deletedAt: msg.deletedAt,
      partnerId: msg.from
    });
  }
}

function handleEdit(targetId, newContent) {
  const msg = dbRef.msgs.find(x => x.id === targetId);
  const text = textOf(normalizeMessageContent(newContent));
  if (!msg || !text || text === msg.text) return;
  if (msg.originalText === undefined) msg.originalText = msg.text;
  msg.text = text;
  msg.edited = true;
  saveDbRef?.();
  emitOwner("message_edited", { msgId: msg.id, text, partnerId: partnerOf(msg) });
}

function handleReaction(reaction, contact, fromMe) {
  const msg = dbRef.msgs.find(x => x.id === reaction?.key?.id);
  if (!msg) return;
  const who = fromMe ? getOwnerUserId() : contact.id;
  const whoName = fromMe ? dbRef.users.find(u => u.id === who)?.name || "You" : contact.name;
  msg.reactions = msg.reactions || {};
  if (reaction.text) msg.reactions[who] = { emoji: reaction.text, name: whoName };
  else delete msg.reactions[who];
  saveDbRef?.();
  emitOwner("message_reaction", { msgId: msg.id, reactions: msg.reactions, partnerId: partnerOf(msg) });
}

async function downloadImage(m, content) {
  const img = content.imageMessage;
  const size = Number(img.fileLength || 0);
  if (size && size > MAX_MEDIA_BYTES) return null;
  try {
    const buf = await downloadMediaMessage(
      { ...m, message: content },
      "buffer",
      {},
      { logger, reuploadRequest: waSocket?.updateMediaMessage }
    );
    if (!buf || buf.length > MAX_MEDIA_BYTES) return null;
    return {
      type: "image",
      data: `data:${img.mimetype || "image/jpeg"};base64,${buf.toString("base64")}`,
      name: "whatsapp-photo.jpg",
      size: buf.length
    };
  } catch (err) {
    console.error("Could not download WhatsApp photo:", err.message);
    return null;
  }
}

async function handleUpsert({ messages, type }) {
  if (!messages || !messages.length || !dbRef) return;
  const owner = getOwnerUserId() || "me";

  for (const m of messages) {
    if (!m.message || !m.key?.remoteJid) continue;
    const content = normalizeMessageContent(m.message);
    if (!content) continue;
    const fromMe = !!m.key.fromMe;

    // Delete-for-everyone / edits arrive as protocol messages
    const proto = content.protocolMessage;
    if (proto) {
      if (proto.type === 0 && proto.key?.id) handleRevoke(proto.key.id);
      else if (proto.type === 14 && proto.key?.id && proto.editedMessage) handleEdit(proto.key.id, proto.editedMessage);
      continue;
    }

    const res = C.resolveContact(dbRef, {
      remoteJid: m.key.remoteJid,
      senderPn: m.key.senderPn,
      fromMe,
      pushName: m.pushName
    });
    if (!res) continue; // groups, channels, status updates
    const contact = res.contact;
    if (res.created) emitOwner("user_updated", pubFn(contact));
    else if (res.changed) emitOwner("user_updated", pubFn(contact));
    applyMerges(res.merges);
    if (res.created || res.changed) saveDbRef?.();

    if (content.reactionMessage) {
      handleReaction(content.reactionMessage, contact, fromMe);
      continue;
    }

    const id = m.key.id || crypto.randomUUID();
    if (dbRef.msgs.some(x => x.id === id)) continue; // already saved (e.g. echo of a message sent from this app)

    let text = textOf(content);
    let media = null;
    if (content.imageMessage) {
      media = await downloadImage(m, content);
      if (!media && !text) text = "📷 Photo";
    } else if (!text) {
      text = describe(content);
    }
    if (!text && !media) continue;

    const newMsg = {
      id,
      from: fromMe ? owner : contact.id,
      to: fromMe ? contact.id : owner,
      text,
      media,
      t: m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now(),
      status: fromMe ? "sent" : "delivered",
      isWhatsApp: true,
      waRemoteJid: m.key.remoteJid,
      reactions: {}
    };
    if (dbRef.msgs.some(x => x.id === id)) continue; // saved while downloading
    dbRef.msgs.push(newMsg);
    saveDbRef?.();
    emitOwner("message", { ...newMsg, silent: type !== "notify" });
    if (!fromMe) subscribePresence(contact);
  }
}

function handleUpdates(updates) {
  if (!Array.isArray(updates) || !dbRef) return;
  for (const { key, update } of updates) {
    if (!key?.id || !update) continue;
    if (update.message === null && update.messageStubType === 1) {
      handleRevoke(key.id);
      continue;
    }
    const st = statusFromWa(update.status);
    if (!st) continue;
    const msg = dbRef.msgs.find(x => x.id === key.id);
    if (!msg || msg.from !== getOwnerUserId()) continue;
    if ((STATUS_RANK[st] || 0) <= (STATUS_RANK[msg.status] || 0)) continue;
    msg.status = st;
    delete msg.error;
    saveDbRef?.();
    emitOwner("msg_status", { id: msg.id, status: st, partnerId: msg.to });
    if (st === "read") {
      const contact = dbRef.users.find(u => u.id === msg.to);
      if (contact) notifyOpened(contact, "read");
    }
  }
}

function handlePresence({ id, presences }) {
  const contact = contactForJid(id);
  if (!contact || !presences) return;
  for (const p of Object.values(presences)) {
    const state = p?.lastKnownPresence;
    if (!state) continue;
    const typing = state === "composing" || state === "recording";
    emitOwner("typing", { from: contact.id, typing, draft: "" });
    if (typing) notifyOpened(contact, "typing");
    if (state === "available" || state === "unavailable") {
      emitOwner("wa_presence", { id: contact.id, online: state === "available" });
    }
  }
}

/* ---------------- outgoing ---------------- */

function ensureConnected() {
  if (!waSocket || connectionStatus !== "connected") {
    throw new Error("WhatsApp is not connected. Please scan the QR code to link your device.");
  }
}

function newMessageId() {
  try {
    if (generateMessageIDV2) return generateMessageIDV2(waSocket?.user?.id);
  } catch {}
  return generateMessageID();
}

// contact: a WhatsApp contact object (or a raw number/jid string)
async function sendWhatsAppMessage(contact, { text = "", media = null, id } = {}) {
  ensureConnected();
  const jid =
    typeof contact === "string"
      ? contact.includes("@")
        ? contact
        : C.normalizePhone(contact) + "@s.whatsapp.net"
      : C.jidForContact(contact);
  if (!jid) throw new Error("This WhatsApp contact has no number.");

  let payload;
  if (media && media.type === "image" && typeof media.data === "string" && media.data.startsWith("data:")) {
    const b64 = media.data.slice(media.data.indexOf(",") + 1);
    payload = { image: Buffer.from(b64, "base64"), caption: text || undefined };
  } else if (media) {
    throw new Error("Voice notes can't be sent to real WhatsApp contacts yet. Please type a message instead.");
  } else {
    if (!text) throw new Error("Message is empty.");
    payload = { text };
  }

  const result = await waSocket.sendMessage(jid, payload, id ? { messageId: id } : undefined);
  if (typeof contact !== "string") lookupLid(contact);
  return { id: result?.key?.id || id, jid };
}

async function revokeWhatsAppMessage(msg, contact) {
  ensureConnected();
  const jid = msg.waRemoteJid || C.jidForContact(contact);
  await waSocket.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: msg.id } });
}

async function reactWhatsAppMessage(msg, contact, emoji, ownerId) {
  ensureConnected();
  const jid = msg.waRemoteJid || C.jidForContact(contact);
  await waSocket.sendMessage(jid, {
    react: { text: emoji || "", key: { remoteJid: jid, id: msg.id, fromMe: msg.from === ownerId } }
  });
}

function markRead(msgs) {
  if (!waSocket || connectionStatus !== "connected") return;
  const keys = (msgs || [])
    .filter(m => m.isWhatsApp && m.waRemoteJid)
    .map(m => ({ remoteJid: m.waRemoteJid, id: m.id, fromMe: false }));
  if (keys.length) waSocket.readMessages(keys).catch(() => {});
}

function sendTyping(contact, typing) {
  if (!waSocket || connectionStatus !== "connected" || !contact) return;
  const jid = C.jidForContact(contact);
  const state = typing ? "composing" : "paused";
  if (!jid || lastTypingSent[jid] === state) return;
  lastTypingSent[jid] = state;
  waSocket.sendPresenceUpdate(state, jid).catch(() => {});
}

async function logoutWhatsApp() {
  clearTimeout(reconnectTimer);
  try {
    if (waSocket) {
      const s = waSocket;
      waSocket = null;
      await s.logout().catch(() => {});
      s.end();
    }
  } catch {}

  connectionStatus = "disconnected";
  currentQR = null;
  connectedUser = null;

  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("Error clearing WhatsApp auth directory:", err);
  }

  ioInstance?.emit("wa_status_update", getStatus());
  return { ok: true };
}

module.exports = {
  initWhatsApp,
  connectToWhatsApp,
  getStatus,
  sendWhatsAppMessage,
  revokeWhatsAppMessage,
  reactWhatsAppMessage,
  markRead,
  sendTyping,
  subscribePresence,
  newMessageId,
  logoutWhatsApp,
  setOwnerUserId,
  getOwnerUserId,
  isConnected: () => connectionStatus === "connected",
  // exported for tests
  _handleUpsert: handleUpsert,
  _handleUpdates: handleUpdates
};
