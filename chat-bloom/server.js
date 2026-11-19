const express = require("express"),
  http = require("http"),
  { Server } = require("socket.io"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken"),
  fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");

const wa = require("./whatsapp.js");
const waContacts = require("./wa-contacts.js");

const os = require("os");
const isVercel = !!process.env.VERCEL;
const defaultFile = path.join(__dirname, "data.json");
const tmpFile = path.join(os.tmpdir(), "chat-bloom-data.json");
let FILE = process.env.DB_FILE || (isVercel ? tmpFile : defaultFile);

let db = { secret: crypto.randomBytes(32).toString("hex"), users: [], msgs: [], moments: [] };
try {
  if (isVercel && !fs.existsSync(FILE) && fs.existsSync(defaultFile)) {
    fs.copyFileSync(defaultFile, FILE);
  }
} catch {}

try {
  const sourcePath = fs.existsSync(FILE) ? FILE : (fs.existsSync(defaultFile) ? defaultFile : null);
  if (sourcePath) {
    const loaded = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    db = Object.assign(db, loaded);
    if (!db.moments) db.moments = [];
  }
} catch {}

let timer;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    } catch (err) {
      if ((err.code === "EROFS" || err.code === "EACCES") && FILE !== tmpFile) {
        FILE = tmpFile;
        try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } catch {}
      } else {
        console.error("Save error:", err);
      }
    }
  }, 300);
};
save();

const app = express(),
  server = http.createServer(app),
  io = new Server(server, {
    maxHttpBufferSize: 25 * 1024 * 1024 // 25 MB for media/voice
  });

// Handle socket.io polling requests in serverless environments (e.g. Vercel)
app.all("/socket.io*", (req, res) => {
  io.engine.handleRequest(req, res);
});


app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/preview", express.static(path.join(__dirname, "preview")));

const pub = u => ({
  id: u.id,
  username: u.username,
  name: u.name,
  bio: u.bio || "Hey there! I am using Chat Bloom Moments.",
  avatar: u.avatar || null,
  color: u.color || null,
  isWhatsApp: !!u.isWhatsApp,
  waJid: u.waJid || null,
  isAI: !!u.isAI
});

// Ensure Bloom AI (Meta AI style assistant) user
const AI_USER_ID = "bloom_ai";
const ensureAiUser = () => {
  if (!db.users.some(u => u.id === AI_USER_ID)) {
    db.users.unshift({
      id: AI_USER_ID,
      username: "bloom_ai",
      name: "Bloom AI ✦",
      bio: "Your Meta AI-style assistant. Ask questions, draft messages, or summarize.",
      color: "linear-gradient(135deg, #0284c7, #6366f1, #d946ef)",
      isAI: true,
      online: true
    });
    save();
  }
};
ensureAiUser();

// Initialize WhatsApp engine (emitTo/online are defined further below; only used later at runtime)
wa.initWhatsApp(io, db, save, { emitTo: (id, e, d) => emitTo(id, e, d), pub });

const isWaOwner = uid => wa.getOwnerUserId() === uid;

function generateAiResponse(prompt, history = []) {
  const p = (prompt || "").trim().toLowerCase();

  if (/^(hi|hello|hey|hola|namaste|sup|good morning|good evening)\b/i.test(p)) {
    return "Hey there! 👋 I'm **Bloom AI**, your personal WhatsApp assistant. I can help you:\n\n• ✍️ **Draft messages** (formal, casual, apologies, congrats)\n• 📊 **Summarize** your recent chats\n• 🌐 **Translate** text into any language\n• 💡 Answer questions and brainstorm ideas!\n\nWhat can I help you with today?";
  }

  if (p.includes("who are you") || p.includes("what can you do")) {
    return "I am **Bloom AI ✦**, an intelligent assistant built into Chat Bloom Moments. You can chat with me here, or use the **✨ AI Smart Actions** button in any chat to polish messages, summarize conversations, or translate text!";
  }

  if (p.includes("summarize") || p.includes("summary")) {
    return "📊 **Conversation Summary**:\n\n• **Core Topic:** Coordination, project updates, and timing.\n• **Key Takeaway:** Discussions are on track; next steps are set.\n• **Action Item:** Confirm schedule and check messages tomorrow.";
  }

  if (p.startsWith("draft") || p.startsWith("write") || p.includes("write an email") || p.includes("say that") || p.includes("reply saying")) {
    if (p.includes("late") || p.includes("delay")) {
      return "Here's a friendly draft you can send:\n\n> *\"Hey! Just wanted to give you a quick heads-up that I'm running about 15 minutes behind schedule due to traffic. Really sorry for the delay, will be there shortly! 🙏\"*";
    }
    if (p.includes("formal") || p.includes("sick") || p.includes("leave")) {
      return "Here is a formal draft:\n\n> *\"Dear Team, please be informed that I am feeling unwell today and will be taking sick leave. I will check urgent messages periodically. Thank you for understanding.\"*";
    }
    return `Here is a polished draft for you:\n\n> *"Hi! Following up on your message. Let's touch base soon so we can finalize the next steps together. Hope you're having a great week! 😊"*`;
  }

  if (p.includes("translate")) {
    if (p.includes("hindi") || p.includes("in hindi")) {
      return "🇮🇳 **Hindi Translation**:\n\n> *\"नमस्ते! मैं आपसे जल्द ही बात करूंगा। आपका दिन मंगलमय हो!\"*";
    }
    if (p.includes("spanish") || p.includes("espanol")) {
      return "🇪🇸 **Spanish Translation**:\n\n> *\"¡Hola! Me pondré en contacto contigo pronto. ¡Que tengas un excelente día!\"*";
    }
    if (p.includes("french")) {
      return "🇫🇷 **French Translation**:\n\n> *\"Bonjour! Je vous contacterai bientôt. Passez une excellente journée!\"*";
    }
    return `🌐 **Translation**:\n\n> *\"${prompt.replace(/.*translate\s*/i, '')}\"* [Translated: Ready for immediate communication]`;
  }

  if (p.includes("joke")) {
    const jokes = [
      "Why do programmers prefer dark mode? Because light attracts bugs! 🐛😄",
      "Why did the smartphone go to school? Because it wanted to be smarter! 📱📚",
      "There are 10 types of people in the world: those who understand binary, and those who don't. 💻"
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  if (p.includes("feature") || p.includes("god")) {
    return "⚡ **Chat Bloom Moments God Features**:\n\n1. 🔗 **Real WhatsApp Multi-Device Sync**: Link your physical phone with QR and message actual WhatsApp users!\n2. ⏱️ **Scheduled Messages**: Schedule messages to send at any exact time in the future.\n3. ⏳ **Disappearing Messages**: Set self-destruct timers (10s, 24h, 7d).\n4. 🎙️ **Voice Notes**: WhatsApp waveform audio recording with 1.5x/2x playback.\n5. 🌸 **Moments / Stories**: 24-hour status tray with full-screen viewer.\n6. ✦ **Bloom AI**: Direct AI assistant for drafting, summarization, and translation.\n7. 📞 **Voice & Video Simulation**: Authentic WhatsApp calling interface with ringtones.\n8. 🎨 **Custom Wallpapers**: SVG doodle wallpapers with dark & light mode.";
  }

  return `That's a great thought! Regarding: **"${prompt}"**\n\nI can help you expand on this, write a reply, or format this for your contacts. Would you like me to draft a message or organize this into bullet points? ✨`;
}

const tok = u => jwt.sign({ id: u.id }, db.secret, { expiresIn: "7d" });

const hits = {};
const limited = ip => {
  const n = Date.now(),
    a = (hits[ip] = (hits[ip] || []).filter(t => n - t < 6e4));
  a.push(n);
  return a.length > 30;
};

// Auth Middleware
const auth = (q, r, n) => {
  try {
    const raw = (q.headers.authorization || "").replace("Bearer ", "");
    q.uid = jwt.verify(raw, db.secret).id;
    if (!db.users.some(u => u.id === q.uid)) throw new Error("unknown user");
    n();
  } catch {
    r.status(401).json({ error: "Please log in again." });
  }
};

// Auth Endpoints
app.post("/api/register", async (q, r) => {
  if (limited(q.ip)) return r.status(429).json({ error: "Too many attempts. Try again in a minute." });
  const { username, name, password, bio } = q.body || {};
  if (!/^[a-z0-9_]{3,20}$/i.test(username || "")) {
    return r.status(400).json({ error: "Username: 3–20 letters, numbers or _." });
  }
  if (!password || password.length < 6) {
    return r.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return r.status(409).json({ error: "That username is taken." });
  }

  const hues = [
    "linear-gradient(135deg, #10b981, #047857)",
    "linear-gradient(135deg, #3b82f6, #1d4ed8)",
    "linear-gradient(135deg, #8b5cf6, #6d28d9)",
    "linear-gradient(135deg, #ec4899, #be185d)",
    "linear-gradient(135deg, #f59e0b, #d97706)",
    "linear-gradient(135deg, #06b6d4, #0e7490)",
    "linear-gradient(135deg, #f97316, #c2410c)"
  ];
  const color = hues[Math.floor(Math.random() * hues.length)];

  const u = {
    id: crypto.randomUUID(),
    username,
    name: String(name || username).slice(0, 40),
    bio: String(bio || "Hey there! I am using Chat Bloom Moments.").slice(0, 120),
    color,
    hash: await bcrypt.hash(password, 10)
  };

  db.users.push(u);
  save();
  r.json({ token: tok(u), user: pub(u) });
});

app.post("/api/login", async (q, r) => {
  if (limited(q.ip)) return r.status(429).json({ error: "Too many attempts. Try again in a minute." });
  const { username, password } = q.body || {};
  const u = db.users.find(x => x.username.toLowerCase() === String(username || "").toLowerCase());
  if (!u || !(await bcrypt.compare(String(password || ""), u.hash))) {
    return r.status(401).json({ error: "Wrong username or password." });
  }
  r.json({ token: tok(u), user: pub(u) });
});

// User & Profile Endpoints
app.get("/api/users", auth, (q, r) => {
  ensureAiUser();
  r.json(
    db.users
      // Real WhatsApp contacts belong only to the account that linked WhatsApp
      .filter(u => u.id !== q.uid && (!u.isWhatsApp || isWaOwner(q.uid)))
      .map(u => {
        const pair = db.msgs.filter(
          m => !isExpired(m) && ((m.from === q.uid && m.to === u.id) || (m.from === u.id && m.to === q.uid))
        );
        const last = pair.reduce((a, m) => (!a || m.t >= a.t ? m : a), null);
        return {
          ...pub(u),
          online: (u.isWhatsApp || u.isAI) ? true : online.has(u.id),
          last: last ? viewFor(last, q.uid) : null,
          unread: pair.filter(m => m.to === q.uid && m.status !== "read").length
        };
      })
  );
});

// Quick AI Assistant action endpoint (One-click summarize, formalize, translate)
app.post("/api/ai/assist", auth, (q, r) => {
  const { action, text } = q.body || {};
  let result = "";
  if (action === "summarize") {
    result = "📊 *Summary*: Key updates discussed. All items are progressing on schedule, with next follow-up planned for tomorrow.";
  } else if (action === "formal") {
    result = text ? `Dear Colleague,\n\nI am writing regarding the following: "${text}". Please let me know your thoughts at your earliest convenience.\n\nBest regards.` : "Please write a message to formalize.";
  } else if (action === "casual") {
    result = text ? `Hey! Quick note regarding ${text} 😊 Hope you're doing great, chat soon!` : "Please write a message to rephrase.";
  } else if (action === "hindi") {
    result = text ? `नमस्ते! "${text}" के संदर्भ में संदेश प्राप्त हुआ। धन्यवाद!` : "नमस्ते! कैसे मदद करूँ?";
  } else if (action === "spanish") {
    result = text ? `¡Hola! Con respecto a "${text}", espero que estés muy bien. ¡Saludos!` : "¡Hola! ¿En qué puedo ayudarte?";
  } else {
    result = generateAiResponse(text || action);
  }
  r.json({ ok: true, result });
});

app.post("/api/profile", auth, (q, r) => {
  const u = db.users.find(x => x.id === q.uid);
  if (!u) return r.status(404).json({ error: "User not found" });
  const { name, bio, avatar } = q.body || {};
  if (name && typeof name === "string") u.name = name.slice(0, 40);
  if (bio && typeof bio === "string") u.bio = bio.slice(0, 120);
  if (avatar !== undefined) u.avatar = avatar;
  save();
  io.emit("user_updated", pub(u));
  r.json({ ok: true, user: pub(u) });
});

// Messages Endpoint
// Anti-Delete Ghost Feature: the recipient keeps the original; the sender sees "deleted"
function viewFor(m, uid) {
  const { waRemoteJid, ...rest } = m;
  if (m.deleted && m.deletedBy && m.deletedBy !== uid) {
    return { ...rest, wasRevoked: true, deleted: false };
  }
  if (m.deleted) return { ...rest, text: "This message was deleted", media: null };
  return rest;
}

const isExpired = m => !!m.expiresAt && m.expiresAt <= Date.now();

app.get("/api/messages/:id", auth, (q, r) => {
  const partnerId = q.params.id;
  const list = db.msgs
    .filter(
      m =>
        !isExpired(m) &&
        ((m.from === q.uid && m.to === partnerId) ||
          (m.to === q.uid && m.from === partnerId))
    )
    .sort((a, b) => a.t - b.t)
    .slice(-300)
    .map(m => viewFor(m, q.uid));
  r.json(list);
});

// Moments / Stories Endpoints
app.get("/api/moments", auth, (q, r) => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  db.moments = (db.moments || []).filter(m => m.t > oneDayAgo);
  r.json(db.moments);
});

app.post("/api/moments", auth, (q, r) => {
  const u = db.users.find(x => x.id === q.uid);
  if (!u) return r.status(404).json({ error: "User not found" });
  const { text, bg, media, type } = q.body || {};
  if (!text && !media) return r.status(400).json({ error: "Moment cannot be empty" });

  const moment = {
    id: crypto.randomUUID(),
    userId: u.id,
    userName: u.name,
    userUsername: u.username,
    text: String(text || "").slice(0, 500),
    bg: bg || "linear-gradient(135deg, #00a884, #005c4b)",
    media: media || null,
    type: type || (media ? "media" : "text"),
    t: Date.now()
  };

  db.moments = db.moments || [];
  db.moments.push(moment);
  save();
  io.emit("new_moment", moment);
  r.json(moment);
});

// Real WhatsApp Bridge Endpoints
app.get("/api/whatsapp/status", auth, (q, r) => {
  r.json(wa.getStatus());
});

app.post("/api/whatsapp/connect", auth, async (q, r) => {
  try {
    // The account that links WhatsApp receives its chats
    if (!wa.isConnected()) wa.setOwnerUserId(q.uid);
    const status = await wa.connectToWhatsApp(true);
    r.json(status);
  } catch (err) {
    console.error("WhatsApp connect error:", err);
    r.status(500).json({ error: err.message || "Failed to initialize WhatsApp connection" });
  }
});

app.post("/api/whatsapp/logout", auth, async (q, r) => {
  if (wa.isConnected() && !isWaOwner(q.uid)) {
    return r.status(403).json({ error: "Only the account that linked WhatsApp can unlink it." });
  }
  try {
    const res = await wa.logoutWhatsApp();
    r.json(res);
  } catch (err) {
    r.status(500).json({ error: err.message || "Failed to log out from WhatsApp" });
  }
});

// Create new direct WhatsApp chat by phone number
app.post("/api/whatsapp/new-chat", auth, (q, r) => {
  try {
    const { phone, name } = q.body || {};
    if (!phone) return r.status(400).json({ error: "Phone number is required." });
    let cleanPhone = String(phone).replace(/[^0-9]/g, "");

    // Auto-detect 10-digit phone numbers (common Indian mobile numbers)
    if (cleanPhone.length === 10 && /^[6-9]/.test(cleanPhone)) {
      cleanPhone = "91" + cleanPhone;
    }

    if (cleanPhone.length < 8 || cleanPhone.length > 15) {
      return r.status(400).json({ 
        error: "Invalid phone number. Please enter a valid number with country code (e.g., +91 94601 18040)." 
      });
    }

    if (!isWaOwner(q.uid)) wa.setOwnerUserId(q.uid);
    const jid = cleanPhone + "@s.whatsapp.net";
    let waContact = waContacts.findByPhone(db, cleanPhone);
    if (waContact && name && waContacts.isPlaceholderName(waContact.name)) {
      waContact.name = String(name).slice(0, 40);
      save();
    }
    if (!waContact) {
      waContact = {
        id: "wa_" + cleanPhone,
        username: "wa_" + cleanPhone,
        name: name ? String(name).slice(0, 40) : ("+" + cleanPhone),
        bio: "WhatsApp (" + cleanPhone + ")",
        color: "linear-gradient(135deg, #25d366, #128c7e)",
        isWhatsApp: true,
        waJid: jid,
        online: true
      };
      db.users.push(waContact);
      save();
      emitTo(q.uid, "user_updated", pub(waContact));
    }
    wa.subscribePresence(waContact);
    r.json({ ok: true, user: pub(waContact) });
  } catch (err) {
    console.error("new-chat error:", err);
    r.status(500).json({ error: err.message || "Failed to create WhatsApp chat." });
  }
});

// Real-time Socket.io handling
const online = new Map();
const emitTo = (id, e, d) => (online.get(id) || new Set()).forEach(s => io.to(s).emit(e, d));

io.use((s, n) => {
  try {
    s.uid = jwt.verify(s.handshake.auth.token, db.secret).id;
    n();
  } catch {
    n(new Error("auth"));
  }
});

io.on("connection", s => {
  const me = s.uid;
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(s.id);
  io.emit("presence", { id: me, online: true });

  // Send current WhatsApp status on connect
  s.emit("wa_status_update", wa.getStatus());

  s.on("wa_connect", async () => {
    if (!wa.isConnected()) wa.setOwnerUserId(me);
    await wa.connectToWhatsApp(true);
  });

  s.on("wa_logout", async () => {
    if (wa.isConnected() && !isWaOwner(me)) return;
    await wa.logoutWhatsApp();
  });

  // Send message handler (Supports app-to-app and Real WhatsApp bridging)
  // Send message handler (Supports app-to-app and Real WhatsApp bridging)
  s.on("send_message", async (d, ack) => {
    const text = String(d?.text || "").trim().slice(0, 4000);
    const media = d?.media || null;
    const replyTo = d?.replyTo || null;
    const targetUser = db.users.find(u => u.id === d?.to);

    if ((!text && !media) || !targetUser || targetUser.id === me) {
      return ack?.({ error: "Invalid message" });
    }
    if (targetUser.isWhatsApp && !isWaOwner(me)) {
      return ack?.({ error: "Only the account that linked WhatsApp can message WhatsApp contacts." });
    }

    // Check for scheduled message
    if (d.scheduledFor && d.scheduledFor > Date.now()) {
      const schedMsg = {
        id: crypto.randomUUID(),
        from: me,
        to: d.to,
        text: text,
        media: media,
        replyTo: replyTo,
        scheduledFor: d.scheduledFor,
        disappearingDuration: d.disappearingDuration || null,
        t: Date.now(),
        status: "scheduled",
        isWhatsApp: !!targetUser.isWhatsApp
      };
      db.scheduledMsgs = db.scheduledMsgs || [];
      db.scheduledMsgs.push(schedMsg);
      save();
      emitTo(me, "scheduled_message", schedMsg);
      return ack?.({ ok: true, scheduled: true, m: schedMsg });
    }

    const m = {
      // WhatsApp messages use a WhatsApp-style id so the echo from the phone isn't saved twice
      id: targetUser.isWhatsApp ? wa.newMessageId() : crypto.randomUUID(),
      from: me,
      to: d.to,
      text: text || "",
      media: media,
      replyTo: replyTo,
      t: Date.now(),
      status: targetUser.isWhatsApp ? "sent" : (online.has(d.to) ? "delivered" : "sent"),
      isWhatsApp: !!targetUser.isWhatsApp,
      reactions: {}
    };

    if (d.disappearingDuration) {
      m.expiresAt = Date.now() + Number(d.disappearingDuration);
      m.disappearingDuration = Number(d.disappearingDuration);
    }

    db.msgs.push(m);
    save();

    // If target is Bloom AI bot!
    if (targetUser.isAI || d.to === "bloom_ai") {
      emitTo(me, "message", m);
      ack?.({ ok: true, m });

      setTimeout(() => emitTo(me, "typing", { from: "bloom_ai", typing: true }), 400);

      setTimeout(() => {
        emitTo(me, "typing", { from: "bloom_ai", typing: false });
        const aiText = generateAiResponse(text);
        const aiMsg = {
          id: crypto.randomUUID(),
          from: "bloom_ai",
          to: me,
          text: aiText,
          t: Date.now(),
          status: "delivered",
          isAI: true,
          reactions: {}
        };
        db.msgs.push(aiMsg);
        save();
        emitTo(me, "message", aiMsg);
      }, 1000);
      return;
    }

    // If target is a real WhatsApp contact, send through Baileys!
    if (targetUser.isWhatsApp) {
      try {
        const res = await wa.sendWhatsAppMessage(targetUser, { text, media, id: m.id });
        m.waRemoteJid = res.jid;
        save();
      } catch (err) {
        console.error("Error relaying message to real WhatsApp:", err.message);
        m.status = "failed";
        m.error = err.message;
        save();
      }
    } else {
      emitTo(d.to, "message", m);
    }

    const { waRemoteJid, ...clientMsg } = m;
    emitTo(me, "message", clientMsg);
    ack?.(m.error ? { ok: false, error: m.error, m: clientMsg } : { ok: true, m: clientMsg });
  });

  // Ghost Typing & Live Draft (app users) / typing indicator (real WhatsApp)
  s.on("typing", d => {
    if (!d || typeof d.to !== "string") return;
    const target = db.users.find(u => u.id === d.to);
    if (!target) return;
    if (target.isWhatsApp) {
      if (isWaOwner(me)) wa.sendTyping(target, !!d.typing);
      return;
    }
    emitTo(d.to, "typing", { from: me, typing: !!d.typing, draft: String(d.draft || "").slice(0, 300) });
  });

  // Chat Viewing Notification ("Who opened my chat")
  s.on("chat_viewing", d => {
    if (!d || typeof d.to !== "string") return;
    const target = db.users.find(u => u.id === d.to);
    if (!target) return;
    if (target.isWhatsApp) {
      if (isWaOwner(me)) wa.subscribePresence(target);
      return;
    }
    const viewer = db.users.find(u => u.id === me);
    if (viewer) {
      emitTo(d.to, "chat_viewed_by", {
        by: me,
        name: viewer.name,
        username: viewer.username,
        phone: viewer.phone || null,
        avatar: viewer.avatar || null,
        color: viewer.color,
        reason: "opened",
        t: Date.now()
      });
    }
  });

  s.on("chat_leave", d => {
    if (d && typeof d.to === "string") emitTo(d.to, "chat_left_by", { by: me });
  });

  s.on("read", d => {
    if (!d || typeof d.from !== "string") return;
    const changed = [];
    db.msgs.forEach(m => {
      if (m.from === d.from && m.to === me && m.status !== "read") {
        m.status = "read";
        changed.push(m);
      }
    });
    if (changed.length) {
      save();
      const partner = db.users.find(u => u.id === d.from);
      if (partner && partner.isWhatsApp) {
        if (isWaOwner(me)) wa.markRead(changed); // blue ticks on their phone, like WhatsApp Web
      } else {
        emitTo(d.from, "read", { by: me });
      }
    }
  });

  s.on("react_message", (d, ack) => {
    const { msgId, emoji } = d || {};
    const msg = db.msgs.find(m => m.id === msgId);
    if (!msg || (msg.from !== me && msg.to !== me)) return ack?.({ error: "Message not found" });

    if (!msg.reactions) msg.reactions = {};
    const userObj = db.users.find(u => u.id === me);
    const userName = userObj ? userObj.name : "User";

    if (msg.reactions[me] && msg.reactions[me].emoji === emoji) {
      delete msg.reactions[me];
    } else {
      msg.reactions[me] = { emoji, name: userName };
    }

    save();
    const partner = me === msg.from ? msg.to : msg.from;
    const partnerUser = db.users.find(u => u.id === partner);
    if (partnerUser && partnerUser.isWhatsApp && msg.isWhatsApp && isWaOwner(me)) {
      wa.reactWhatsAppMessage(msg, partnerUser, msg.reactions[me] ? emoji : "", me).catch(err =>
        console.error("WhatsApp reaction error:", err.message)
      );
    }
    emitTo(partner, "message_reaction", { msgId, reactions: msg.reactions, partnerId: me });
    emitTo(me, "message_reaction", { msgId, reactions: msg.reactions, partnerId: partner });
    ack?.({ ok: true, reactions: msg.reactions });
  });

  // Delete for everyone. Anti-Delete: the recipient keeps the original content.
  s.on("delete_message", async (d, ack) => {
    const { msgId } = d || {};
    const msg = db.msgs.find(m => m.id === msgId);
    if (!msg) return ack?.({ error: "Message not found" });
    if (msg.from !== me) return ack?.({ error: "You can only delete your own messages." });
    if (msg.deleted) return ack?.({ ok: true });

    const partner = db.users.find(u => u.id === msg.to);
    if (partner && partner.isWhatsApp) {
      try {
        await wa.revokeWhatsAppMessage(msg, partner);
      } catch (err) {
        return ack?.({ error: "Couldn't delete on WhatsApp: " + err.message });
      }
    }

    msg.deleted = true;
    msg.deletedBy = me;
    msg.deletedAt = Date.now();
    save();
    emitTo(msg.to, "message_revoked", {
      msgId,
      deletedBy: me,
      originalText: msg.text,
      originalMedia: msg.media,
      deletedAt: msg.deletedAt,
      partnerId: me
    });
    emitTo(me, "message_deleted", { msgId, partnerId: msg.to });
    ack?.({ ok: true });
  });


  s.on("call_signal", d => {
    if (d && d.to) {
      emitTo(d.to, "call_signal", { ...d, from: me });
    }
  });

  s.on("disconnect", () => {
    const set = online.get(me);
    if (set) {
      set.delete(s.id);
      if (!set.size) {
        online.delete(me);
        io.emit("presence", { id: me, online: false });
      }
    }
  });
});

// Scheduled message dispatcher + disappearing message clean-up (runs every second)
setInterval(async () => {
  const now = Date.now();

  // Disappearing messages: remove once their timer runs out
  const expired = db.msgs.filter(m => m.expiresAt && m.expiresAt <= now);
  if (expired.length) {
    db.msgs = db.msgs.filter(m => !(m.expiresAt && m.expiresAt <= now));
    for (const m of expired) {
      emitTo(m.from, "message_expired", { msgId: m.id, partnerId: m.to });
      emitTo(m.to, "message_expired", { msgId: m.id, partnerId: m.from });
    }
    save();
  }

  if (!db.scheduledMsgs || !db.scheduledMsgs.length) return;
  const ready = db.scheduledMsgs.filter(m => m.scheduledFor <= now);
  if (!ready.length) return;
  db.scheduledMsgs = db.scheduledMsgs.filter(m => m.scheduledFor > now);

  for (const sm of ready) {
    const targetUser = db.users.find(u => u.id === sm.to);
    if (!targetUser) continue;
    const liveMsg = {
      id: targetUser.isWhatsApp ? wa.newMessageId() : sm.id,
      from: sm.from,
      to: sm.to,
      text: sm.text,
      media: sm.media,
      replyTo: sm.replyTo,
      t: Date.now(),
      status: targetUser.isWhatsApp ? "sent" : (online.has(sm.to) ? "delivered" : "sent"),
      isWhatsApp: !!targetUser.isWhatsApp,
      reactions: {}
    };
    if (sm.disappearingDuration) {
      liveMsg.expiresAt = Date.now() + Number(sm.disappearingDuration);
      liveMsg.disappearingDuration = Number(sm.disappearingDuration);
    }
    db.msgs.push(liveMsg);
    if (targetUser.isWhatsApp) {
      try {
        const res = await wa.sendWhatsAppMessage(targetUser, { text: sm.text, media: sm.media, id: liveMsg.id });
        liveMsg.waRemoteJid = res.jid;
      } catch (e) {
        console.error("Scheduled WhatsApp delivery error:", e.message);
        liveMsg.status = "failed";
        liveMsg.error = e.message;
      }
    } else if (!targetUser.isAI) {
      emitTo(sm.to, "message", liveMsg);
    }
    const { waRemoteJid, ...clientMsg } = liveMsg;
    emitTo(sm.from, "scheduled_sent", { scheduledId: sm.id });
    emitTo(sm.from, "message", clientMsg);
  }
  save();
}, 1000);


// Catch-all handler for undefined API routes - returns JSON instead of Express HTML 404
app.all("/api/*", (q, r) => {
  r.status(404).json({ error: `API route '${q.method} ${q.originalUrl}' not found.` });
});

// Express global error-handling middleware - returns JSON 500
app.use((err, q, r, next) => {
  console.error("Unhandled Express error:", err);
  if (r.headersSent) return next(err);
  r.status(500).json({ error: err?.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log("Chat Bloom Moments running on http://localhost:" + PORT);
  });
}

module.exports = app;
module.exports.server = server;
module.exports.io = io;
