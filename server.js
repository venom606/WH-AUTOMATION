/**
 * WhatsApp Automation Tool
 * Legitimate features: auto-reply, scheduled messages, opt-in bulk send,
 * keyword bot, group welcome messages.
 *
 * Uses @whiskeysockets/baileys. Auth is persisted to disk so the linked
 * device stays connected across restarts (this is the main fix vs. the old code).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- persistent storage dirs ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---- in-memory runtime state ----
let sock = null;
let connState = 'disconnected'; // disconnected | connecting | waiting | linked
let currentQR = null;
let currentQRImage = null;
let pairingCode = null;
let lastError = null;
let meJid = null;
const logs = [];

// ---- persisted config (rules, schedules, welcome) ----
let store = {
  autoReply: { enabled: false, message: "Hi! Thanks for your message. I'll get back to you soon." },
  keywords: [], // [{ keyword, reply }]
  welcome: { enabled: false, message: "Welcome to the group, @user! Please read the description." },
  schedules: [], // [{ id, to, message, at (ISO), sent }]
};
function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  } catch (e) { log('Store load failed: ' + e.message); }
}
function saveStore() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { log('Store save failed: ' + e.message); }
}
loadStore();

function log(msg) {
  const t = new Date().toISOString();
  logs.push({ time: t, msg });
  if (logs.length > 150) logs.shift();
  console.log('[' + t + '] ' + msg);
}

async function makeQRImage(data) {
  try {
    return await QRCode.toDataURL(data, { width: 260, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } });
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function startSock(usePairingPhone) {
  if (sock) { try { sock.ev.removeAllListeners(); sock.end(); } catch (e) {} sock = null; }
  connState = 'connecting';
  currentQR = null; currentQRImage = null; pairingCode = null; lastError = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log('Starting socket. Baileys version ' + JSON.stringify(version));

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WA Automation', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    markOnlineOnConnect: false,
  });

  // Persist creds on every update — THIS is what keeps the device linked.
  sock.ev.on('creds.update', saveCreds);

  // Request pairing code if user asked for it and we're not registered yet.
  if (usePairingPhone && !state.creds.registered) {
    const clean = String(usePairingPhone).replace(/\D/g, '').replace(/^0+/, '');
    // small delay so the socket is ready
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(clean);
        pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
        connState = 'waiting';
        log('Pairing code generated: ' + pairingCode);
      } catch (e) {
        lastError = 'Pairing code failed: ' + e.message;
        log(lastError);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (up) => {
    const { connection, lastDisconnect, qr } = up;
    if (qr) {
      currentQR = qr;
      currentQRImage = await makeQRImage(qr);
      if (connState !== 'waiting') connState = 'waiting';
      log('QR updated (length ' + qr.length + ')');
    }
    if (connection === 'open') {
      connState = 'linked';
      currentQR = null; currentQRImage = null; pairingCode = null; lastError = null;
      meJid = sock.user?.id || null;
      log('Connection OPEN. Linked as ' + meJid);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || '';
      log('Connection CLOSED code=' + code + ' msg=' + msg);
      if (code === DisconnectReason.loggedOut) {
        // user unlinked from phone -> wipe auth so next link is fresh
        connState = 'disconnected';
        lastError = 'Logged out from phone. Please link again.';
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (e) {}
        sock = null;
      } else {
        // any other close (restart-required 515, timeout 408, etc.) -> reconnect
        connState = 'connecting';
        log('Reconnecting...');
        setTimeout(() => startSock().catch(e => log('Reconnect error: ' + e.message)), 2500);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Incoming messages: auto-reply + keyword bot
  // -------------------------------------------------------------------------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const isGroup = jid.endsWith('@g.us');
        const text = (m.message.conversation ||
          m.message.extendedTextMessage?.text || '').trim();
        if (!text) continue;

        // Keyword bot (checked first, works in DMs and groups)
        let handled = false;
        for (const k of store.keywords) {
          if (!k.keyword) continue;
          if (text.toLowerCase().includes(k.keyword.toLowerCase())) {
            await sock.sendMessage(jid, { text: k.reply }, { quoted: m });
            log('Keyword reply "' + k.keyword + '" -> ' + jid);
            handled = true;
            break;
          }
        }

        // Auto-reply (DMs only, avoid spamming groups)
        if (!handled && store.autoReply.enabled && !isGroup) {
          await sock.sendMessage(jid, { text: store.autoReply.message });
          log('Auto-reply -> ' + jid);
        }
      } catch (e) { log('msg handle error: ' + e.message); }
    }
  });

  // -------------------------------------------------------------------------
  // Group welcome
  // -------------------------------------------------------------------------
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      if (!store.welcome.enabled || ev.action !== 'add') return;
      for (const p of ev.participants) {
        const name = '@' + p.split('@')[0];
        const msg = store.welcome.message.replace(/@user/g, name);
        await sock.sendMessage(ev.id, { text: msg, mentions: [p] });
        log('Welcomed ' + p + ' in ' + ev.id);
      }
    } catch (e) { log('welcome error: ' + e.message); }
  });

  return sock;
}

// ---------------------------------------------------------------------------
// Scheduler: checks every 30s for due messages
// ---------------------------------------------------------------------------
setInterval(async () => {
  if (connState !== 'linked' || !sock) return;
  const now = Date.now();
  let changed = false;
  for (const s of store.schedules) {
    if (s.sent) continue;
    if (new Date(s.at).getTime() <= now) {
      try {
        await sock.sendMessage(toJid(s.to), { text: s.message });
        s.sent = true; changed = true;
        log('Scheduled message sent -> ' + s.to);
      } catch (e) { log('schedule send error: ' + e.message); }
    }
  }
  if (changed) saveStore();
}, 30000);

function toJid(input) {
  const v = String(input).trim();
  if (v.endsWith('@s.whatsapp.net') || v.endsWith('@g.us')) return v;
  const clean = v.replace(/\D/g, '').replace(/^0+/, '');
  return clean + '@s.whatsapp.net';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/ping', (req, res) => res.json({ ok: true, state: connState, time: new Date().toISOString() }));

app.get('/api/status', (req, res) => {
  res.json({ state: connState, qrImage: currentQRImage, pairingCode, error: lastError, me: meJid });
});

app.post('/api/link', async (req, res) => {
  try {
    const { method, phone } = req.body || {};
    if (connState === 'linked') return res.json({ state: 'linked', me: meJid });
    await startSock(method === 'code' ? phone : null);
    // give it a moment to produce QR / code
    await new Promise(r => setTimeout(r, method === 'code' ? 4000 : 2500));
    res.json({ state: connState, qrImage: currentQRImage, pairingCode, error: lastError });
  } catch (e) { log('link error: ' + e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) { try { await sock.logout(); } catch (e) {} try { sock.end(); } catch (e) {} sock = null; }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true });
    connState = 'disconnected'; currentQR = null; currentQRImage = null; pairingCode = null; meJid = null;
    log('Logged out and auth cleared.');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a single message (manual test / bulk building block)
app.post('/api/send', async (req, res) => {
  try {
    if (connState !== 'linked') return res.status(400).json({ error: 'Not linked yet' });
    const { to, message } = req.body;
    await sock.sendMessage(toJid(to), { text: message });
    log('Manual send -> ' + to);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk send to an opt-in list. Adds a delay between messages to stay safe.
app.post('/api/bulk', async (req, res) => {
  try {
    if (connState !== 'linked') return res.status(400).json({ error: 'Not linked yet' });
    const { recipients, message } = req.body; // recipients: array of numbers/jids
    if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'No recipients' });
    let ok = 0, fail = 0;
    for (const r of recipients) {
      try {
        await sock.sendMessage(toJid(r), { text: message });
        ok++;
        await new Promise(x => setTimeout(x, 4000)); // 4s spacing = safer
      } catch (e) { fail++; }
    }
    log('Bulk send done. ok=' + ok + ' fail=' + fail);
    res.json({ sent: ok, failed: fail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Config: get / update rules
app.get('/api/config', (req, res) => res.json(store));
app.post('/api/config/autoreply', (req, res) => {
  store.autoReply = { enabled: !!req.body.enabled, message: req.body.message || store.autoReply.message };
  saveStore(); res.json(store.autoReply);
});
app.post('/api/config/welcome', (req, res) => {
  store.welcome = { enabled: !!req.body.enabled, message: req.body.message || store.welcome.message };
  saveStore(); res.json(store.welcome);
});
app.post('/api/config/keywords', (req, res) => {
  store.keywords = Array.isArray(req.body.keywords) ? req.body.keywords.filter(k => k.keyword && k.reply) : [];
  saveStore(); res.json(store.keywords);
});

// Schedules
app.post('/api/schedule', (req, res) => {
  const { to, message, at } = req.body;
  if (!to || !message || !at) return res.status(400).json({ error: 'to, message, at required' });
  const item = { id: 'sch_' + Date.now(), to, message, at, sent: false };
  store.schedules.push(item); saveStore();
  res.json(item);
});
app.delete('/api/schedule/:id', (req, res) => {
  store.schedules = store.schedules.filter(s => s.id !== req.params.id);
  saveStore(); res.json({ ok: true });
});

app.get('/api/logs', (req, res) => res.json({ logs }));

app.listen(PORT, () => {
  log('Server started on port ' + PORT);
  // auto-resume if we already have saved credentials
  const credFile = path.join(AUTH_DIR, 'creds.json');
  if (fs.existsSync(credFile)) {
    log('Existing session found, auto-connecting...');
    startSock().catch(e => log('Auto-connect error: ' + e.message));
  }
});
