/**
 * WhatsApp Automation Tool v2.0
 * Features: auto-reply (with working hours + cooldown), keyword bot,
 * scheduled messages, opt-in bulk send, group welcome, blacklist,
 * stats, groups list, link-success notification.
 *
 * PAIRING FIX:
 *  - Pairing code is requested ONLY after the socket is ready (first QR event),
 *    which is the reliable pattern for Baileys. Requesting too early produces
 *    codes WhatsApp rejects.
 *  - Uses a standard browser identity (Browsers.ubuntu) - custom browser
 *    strings are a known cause of "code not working".
 *  - Stale/partial auth files are wiped before a fresh pairing attempt.
 *  - On successful link, a confirmation notification is sent to your own number.
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
  jidNormalizedUser,
  Browsers,
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

// ---- runtime state ----
let sock = null;
let connState = 'disconnected'; // disconnected | connecting | waiting | linked
let currentQRImage = null;
let pairingCode = null;         // display version XXXX-XXXX
let pairingCodeRaw = null;      // raw 8 chars for copy button
let lastError = null;
let meJid = null;
let pendingPairPhone = null;    // phone waiting for a pairing code
let pairingRequested = false;
let freshLink = false;          // true when this session was just linked now
const logs = [];

// ---- persisted config ----
let store = {
  autoReply: {
    enabled: false,
    message: "Hi! Thanks for your message. I'll get back to you soon.",
    cooldownMin: 30,             // don't auto-reply to same person again within N minutes
    hoursEnabled: false,
    hoursStart: '18:00',
    hoursEnd: '08:00',
  },
  keywords: [],                  // [{ keyword, reply }]
  welcome: { enabled: false, message: 'Welcome to the group, @user! Please read the description.' },
  schedules: [],                 // [{ id, to, message, at, sent }]
  blacklist: [],                 // numbers to ignore completely
  notifyOnLink: true,
  stats: { received: 0, sent: 0, autoReplies: 0, keywordReplies: 0, welcomes: 0, scheduled: 0, bulk: 0 },
};
function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      store = { ...store, ...saved, autoReply: { ...store.autoReply, ...(saved.autoReply || {}) }, stats: { ...store.stats, ...(saved.stats || {}) } };
    }
  } catch (e) { log('Store load failed: ' + e.message); }
}
function saveStore() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { log('Store save failed: ' + e.message); }
}
loadStore();

const lastAutoReply = new Map(); // jid -> timestamp (cooldown)

function log(msg, type) {
  const t = new Date().toISOString();
  logs.push({ time: t, msg, type: type || 'info' });
  if (logs.length > 200) logs.shift();
  console.log('[' + t + '] ' + msg);
}

async function makeQRImage(data) {
  try {
    return await QRCode.toDataURL(data, { width: 280, margin: 1, color: { dark: '#052e16', light: '#ffffff' } });
  } catch (e) { return null; }
}

function toJid(input) {
  const v = String(input).trim();
  if (v.endsWith('@s.whatsapp.net') || v.endsWith('@g.us')) return v;
  const clean = v.replace(/\D/g, '').replace(/^0+/, '');
  return clean + '@s.whatsapp.net';
}

function cleanPhone(p) {
  return String(p).replace(/\D/g, '').replace(/^0+/, '');
}

function isBlacklisted(jid) {
  const num = jid.split('@')[0].split(':')[0];
  return store.blacklist.some(b => cleanPhone(b) === num);
}

function withinWorkingHours() {
  const ar = store.autoReply;
  if (!ar.hoursEnabled) return true;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = (ar.hoursStart || '00:00').split(':').map(Number);
  const [eh, em] = (ar.hoursEnd || '23:59').split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end; // overnight window e.g. 18:00 -> 08:00
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function startSock(usePairingPhone) {
  if (sock) { try { sock.ev.removeAllListeners(); sock.end(); } catch (e) {} sock = null; }
  connState = 'connecting';
  currentQRImage = null; pairingCode = null; pairingCodeRaw = null; lastError = null;
  pairingRequested = false;
  pendingPairPhone = usePairingPhone ? cleanPhone(usePairingPhone) : null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log('Starting socket. Baileys version ' + JSON.stringify(version));

  const wasRegistered = !!state.creds.registered;

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    // IMPORTANT: standard browser identity. Custom names break pairing codes.
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (up) => {
    const { connection, lastDisconnect, qr } = up;

    if (qr) {
      // Socket handshake is ready when the first QR arrives.
      // THIS is the correct moment to request a pairing code.
      if (pendingPairPhone && !pairingRequested && !wasRegistered) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(pendingPairPhone);
          pairingCodeRaw = code;
          pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
          currentQRImage = null;
          connState = 'waiting';
          log('Pairing code generated: ' + pairingCode, 'ok');
        } catch (e) {
          lastError = 'Pairing code failed: ' + e.message + '. Check the number (country code, no + / no leading 0).';
          log(lastError, 'err');
        }
      } else if (!pendingPairPhone) {
        currentQRImage = await makeQRImage(qr);
        connState = 'waiting';
        log('QR updated');
      }
    }

    if (connection === 'open') {
      const firstLink = connState !== 'linked';
      connState = 'linked';
      currentQRImage = null; pairingCode = null; pairingCodeRaw = null; lastError = null;
      pendingPairPhone = null;
      meJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      log('Connection OPEN. Linked as ' + meJid, 'ok');

      // Send success notification to the linked number itself
      if (firstLink && freshLink && store.notifyOnLink && meJid) {
        freshLink = false;
        setTimeout(async () => {
          try {
            await sock.sendMessage(meJid, {
              text: '✅ *WhatsApp Automation linked successfully!*\n\n' +
                    '📱 Device: WA Automation Panel\n' +
                    '🕐 Time: ' + new Date().toLocaleString() + '\n\n' +
                    'Your automation panel is now active. Auto-reply, keyword bot, schedules and welcome messages will run from this device.\n\n' +
                    '_If this was not you, remove this device from WhatsApp → Linked Devices._',
            });
            log('Link notification sent to ' + meJid, 'ok');
          } catch (e) { log('Link notification failed: ' + e.message, 'err'); }
        }, 2000);
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || '';
      log('Connection CLOSED code=' + code + ' msg=' + msg, 'err');
      if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
        connState = 'disconnected';
        lastError = 'Logged out from phone. Please link again.';
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (e) {}
        sock = null;
      } else {
        connState = 'connecting';
        log('Reconnecting...');
        setTimeout(() => startSock().catch(e => log('Reconnect error: ' + e.message, 'err')), 2500);
      }
    }
  });

  // ---- incoming messages: auto-reply + keyword bot ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        if (isBlacklisted(jid)) continue;
        const isGroup = jid.endsWith('@g.us');
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
        if (!text) continue;

        store.stats.received++;

        let handled = false;
        for (const k of store.keywords) {
          if (!k.keyword) continue;
          if (text.toLowerCase().includes(k.keyword.toLowerCase())) {
            await sock.sendMessage(jid, { text: k.reply }, { quoted: m });
            store.stats.keywordReplies++; store.stats.sent++;
            log('Keyword reply "' + k.keyword + '" -> ' + jid);
            handled = true;
            break;
          }
        }

        if (!handled && store.autoReply.enabled && !isGroup && withinWorkingHours()) {
          const last = lastAutoReply.get(jid) || 0;
          const cooldownMs = (store.autoReply.cooldownMin || 0) * 60000;
          if (Date.now() - last >= cooldownMs) {
            await sock.sendMessage(jid, { text: store.autoReply.message });
            lastAutoReply.set(jid, Date.now());
            store.stats.autoReplies++; store.stats.sent++;
            log('Auto-reply -> ' + jid);
          }
        }
        saveStore();
      } catch (e) { log('msg handle error: ' + e.message, 'err'); }
    }
  });

  // ---- group welcome ----
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      if (!store.welcome.enabled || ev.action !== 'add') return;
      for (const p of ev.participants) {
        const name = '@' + p.split('@')[0];
        const msg = store.welcome.message.replace(/@user/g, name);
        await sock.sendMessage(ev.id, { text: msg, mentions: [p] });
        store.stats.welcomes++; store.stats.sent++;
        log('Welcomed ' + p + ' in ' + ev.id);
      }
      saveStore();
    } catch (e) { log('welcome error: ' + e.message, 'err'); }
  });

  return sock;
}

// ---- scheduler ----
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
        store.stats.scheduled++; store.stats.sent++;
        log('Scheduled message sent -> ' + s.to, 'ok');
      } catch (e) { log('schedule send error: ' + e.message, 'err'); }
    }
  }
  if (changed) saveStore();
}, 30000);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/ping', (req, res) => res.json({ ok: true, state: connState, time: new Date().toISOString() }));

app.get('/api/status', (req, res) => {
  res.json({
    state: connState, qrImage: currentQRImage,
    pairingCode, pairingCodeRaw,
    error: lastError, me: meJid, stats: store.stats,
  });
});

app.post('/api/link', async (req, res) => {
  try {
    const { method, phone } = req.body || {};
    if (connState === 'linked') return res.json({ state: 'linked', me: meJid });

    if (method === 'code') {
      const clean = cleanPhone(phone || '');
      if (clean.length < 9 || clean.length > 15) {
        return res.status(400).json({ error: 'Invalid number. Use full international format with country code, e.g. 9477XXXXXXX (no +, no leading 0).' });
      }
    }

    // Wipe stale/partial auth before a fresh link attempt.
    // Old half-written keys are the #1 cause of pairing codes that never work.
    try {
      const credFile = path.join(AUTH_DIR, 'creds.json');
      let registered = false;
      if (fs.existsSync(credFile)) {
        try { registered = !!JSON.parse(fs.readFileSync(credFile, 'utf8')).registered; } catch (e) {}
      }
      if (!registered) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        log('Cleared stale auth for fresh link.');
      }
    } catch (e) {}

    freshLink = true;
    await startSock(method === 'code' ? phone : null);

    // wait up to ~15s for a code or QR to be ready
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (pairingCode || currentQRImage || lastError || connState === 'linked') break;
      await new Promise(r => setTimeout(r, 400));
    }
    res.json({ state: connState, qrImage: currentQRImage, pairingCode, pairingCodeRaw, error: lastError });
  } catch (e) { log('link error: ' + e.message, 'err'); res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) { try { await sock.logout(); } catch (e) {} try { sock.end(); } catch (e) {} sock = null; }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true });
    connState = 'disconnected'; currentQRImage = null; pairingCode = null; pairingCodeRaw = null; meJid = null;
    log('Logged out and auth cleared.');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// manual single send
app.post('/api/send', async (req, res) => {
  try {
    if (connState !== 'linked') return res.status(400).json({ error: 'Not linked yet' });
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message required' });
    await sock.sendMessage(toJid(to), { text: message });
    store.stats.sent++; saveStore();
    log('Manual send -> ' + to);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// opt-in bulk send with safe spacing
app.post('/api/bulk', async (req, res) => {
  try {
    if (connState !== 'linked') return res.status(400).json({ error: 'Not linked yet' });
    const { recipients, message } = req.body;
    if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'No recipients' });
    if (!message) return res.status(400).json({ error: 'No message' });
    let ok = 0, fail = 0;
    for (const r of recipients) {
      try {
        await sock.sendMessage(toJid(r), { text: message });
        ok++; store.stats.bulk++; store.stats.sent++;
        await new Promise(x => setTimeout(x, 4000 + Math.floor(Math.random() * 2000)));
      } catch (e) { fail++; }
    }
    saveStore();
    log('Bulk send done. ok=' + ok + ' fail=' + fail);
    res.json({ sent: ok, failed: fail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// groups the account participates in
app.get('/api/groups', async (req, res) => {
  try {
    if (connState !== 'linked') return res.status(400).json({ error: 'Not linked yet' });
    const groups = await sock.groupFetchAllParticipating();
    res.json(Object.values(groups).map(g => ({ id: g.id, name: g.subject, size: g.participants?.length || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// config
app.get('/api/config', (req, res) => res.json(store));
app.post('/api/config/autoreply', (req, res) => {
  const b = req.body || {};
  store.autoReply = {
    enabled: !!b.enabled,
    message: b.message || store.autoReply.message,
    cooldownMin: Number.isFinite(+b.cooldownMin) ? Math.max(0, +b.cooldownMin) : store.autoReply.cooldownMin,
    hoursEnabled: !!b.hoursEnabled,
    hoursStart: b.hoursStart || store.autoReply.hoursStart,
    hoursEnd: b.hoursEnd || store.autoReply.hoursEnd,
  };
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
app.post('/api/config/blacklist', (req, res) => {
  store.blacklist = Array.isArray(req.body.blacklist) ? req.body.blacklist.map(cleanPhone).filter(Boolean) : [];
  saveStore(); res.json(store.blacklist);
});
app.post('/api/config/notify', (req, res) => {
  store.notifyOnLink = !!req.body.enabled;
  saveStore(); res.json({ notifyOnLink: store.notifyOnLink });
});

// schedules
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
app.post('/api/stats/reset', (req, res) => {
  store.stats = { received: 0, sent: 0, autoReplies: 0, keywordReplies: 0, welcomes: 0, scheduled: 0, bulk: 0 };
  saveStore(); res.json(store.stats);
});

app.listen(PORT, () => {
  log('Server started on port ' + PORT);
  const credFile = path.join(AUTH_DIR, 'creds.json');
  if (fs.existsSync(credFile)) {
    try {
      const registered = !!JSON.parse(fs.readFileSync(credFile, 'utf8')).registered;
      if (registered) {
        log('Existing session found, auto-connecting...');
        startSock().catch(e => log('Auto-connect error: ' + e.message, 'err'));
      }
    } catch (e) {}
  }
});
