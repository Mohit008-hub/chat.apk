# Chat Bloom Moments (God Edition ⚡)

A fullstack WhatsApp Web clone featuring real-time messaging, authentic WhatsApp Web UI, Real WhatsApp Multi-Device Sync (via Baileys), and exclusive God Features.

---

## ⚡ God Features
1. **👀 Profile Viewer & Chat Opened Alerts:** Receive real-time toast alerts (`👀 Profile Viewer: [User] opened your chat`) and animated header status indicators when anyone opens your conversation.
2. **🛡️ Anti-Delete Ghost Mode:** When a sender uses "Delete for everyone", the message remains fully visible to you marked with a `🚫 Deleted by sender • Saved by Anti-Delete` badge. Toggle ON/OFF anytime in Settings.
3. **👁️ Live Draft Spy (Ghost Typing):** See what the opposite person is typing character-by-character in real time before they send it, with a dedicated Live Draft bar and dynamic header status.
4. **🔗 Real WhatsApp Multi-Device Linking:** Link your physical WhatsApp with a QR code (powered by `@whiskeysockets/baileys`) and chat with real WhatsApp contacts directly from this web app!

### How these work with real WhatsApp contacts
Real WhatsApp only shares some information, so for real WhatsApp chats:
- **Chat opened alerts** pop up when the person **reads your messages** (blue ticks) or **starts typing to you**. WhatsApp never says when someone just opens a chat, and if they turned off read receipts you won't get the "read" alert.
- **Anti-Delete** works fully: if they "Delete for everyone", you still see the message.
- **Live drafts** only work between Chat Bloom accounts. Real WhatsApp never sends unsent text, so you see "typing…" instead.

### Fixes in this version
- Replies from real WhatsApp users now go into the same chat, not a separate receive-only chat. This covers WhatsApp's hidden-number addressing and numbers saved without the 91 country code. Existing duplicate chats are merged automatically when the server starts.
- Messages you send from the app are no longer saved twice.
- Only the account that linked WhatsApp can see and send its WhatsApp chats.
- WhatsApp reconnects by itself after a server restart.
- Photos, edits, reactions, delivered/read ticks, and deletes now go both ways with real WhatsApp. Group chats are ignored instead of showing up as strange contacts.
- Messages that couldn't be sent show a ⚠️ instead of a normal tick.
- Disappearing messages are now removed when their timer ends.
- The Copy button works on messages with apostrophes, your own profile no longer shows up in your chat list, and the chat list shows the last message and sorts newest first.

Run `npm test` to check the fixes.

---

## 🚀 Quick Start

### 1. Requirements
- Node.js 18+ installed

### 2. Install & Start
```bash
# Navigate to project folder
cd chat-bloom

# Install dependencies (Express, Socket.IO, Baileys, QRCode, etc.)
npm install

# Start the server
npm start
```

### 3. Open Web App
- Open your browser at: **http://localhost:3000**
- Sign up or log in.
- Open a second incognito window to chat between two accounts or connect your real WhatsApp phone!

---

## 📱 Offline Preview Mode (No Server Needed)
Simply double-click or open:
`preview/chat-bloom-preview.html`
in any modern web browser to test the full interface, simulated WhatsApp, and god features locally via BroadcastChannel.

---

## 🛠️ Tech Stack
- **Backend:** Node.js, Express, Socket.IO, JWT, bcryptjs, @whiskeysockets/baileys, qrcode
- **Frontend:** Vanilla HTML5, CSS3 (Modern WhatsApp Web Theme with Light/Dark Mode), Web Audio API
- **Persistence:** Local JSON flat-file storage (`data.json`)

## 🔗 Real WhatsApp Linking (Direct QR Code — No Server Key Needed)

Connecting your real WhatsApp is completely built-in and direct. No server keys, tokens, or external bridges required!

1. Start the server:
   ```bash
   npm start
   ```
2. Open your web app at `http://localhost:3000` and log in.
3. Open the menu → **Link WhatsApp** (or tap the WhatsApp icon in the header).
4. Scan the QR code with WhatsApp on your phone (**Linked Devices** → **Link a device**).
5. Done! Your real WhatsApp is now directly connected to Chat Bloom. All WhatsApp chats, anti-delete, media, and receipts will sync automatically.

`npm test` runs all automated test suites.

---

## ☁️ Deploying to the Web

### Deploy to Vercel
1. Push or upload this project to a GitHub repository.
2. Go to [Vercel](https://vercel.com) → **Add New Project** → Import your repository.
3. Click **Deploy**. Vercel will automatically read `vercel.json` and deploy the app!

> **Note about Vercel vs Render/Railway:**
> Vercel is a serverless platform (functions sleep when inactive). For 24/7 continuous WhatsApp multi-device sync, you can also deploy for free on **[Render](https://render.com)** (New Web Service → connect repo → Build: `npm install`, Start: `npm start`). Render keeps the Node.js server running 24/7 with active WebSockets!
