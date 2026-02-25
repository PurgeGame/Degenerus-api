import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { isAddress, verifyMessage } from 'ethers';
import {
  getOrCreatePlayer,
  getPlayerByAddress,
  updatePlayerDiscord,
  setPlayerNonce,
  clearPlayerNonce,
  atomicSpin,
  sanitizePlayer,
  setReferrerCode,
  ensureReferralCode,
  setAffiliateConfig,
  getLeaderboard,
  getBiggestWins,
  registerAgent,
  getAgentRegistrations,
} from './storage.js';
import { spinFullTicket } from './game.js';

dotenv.config();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DISCORD_BOT_TOKEN,
  FRONTEND_ORIGIN,
  FRONTEND_REDIRECT,
  SESSION_SECRET,
  SESSION_DB_PATH,
  PORT = 8787,
} = process.env;

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

const app = express();
app.disable('x-powered-by');
if (isProd) {
  app.set('trust proxy', 1);
}

const frontendOrigins = (FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]);

const frontendRedirect = (FRONTEND_REDIRECT
  ? FRONTEND_REDIRECT.trim()
  : (frontendOrigins[0] || 'http://localhost:5173'));

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER
      );
    `);
    this.getStmt = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND (expires IS NULL OR expires > ?)');
    this.setStmt = this.db.prepare(`
      INSERT INTO sessions (sid, sess, expires)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.destroyStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.cleanupStmt = this.db.prepare('DELETE FROM sessions WHERE expires IS NOT NULL AND expires <= ?');
    this.lastCleanup = 0;
  }

  _expires(sessionData) {
    if (sessionData?.cookie?.expires) {
      return new Date(sessionData.cookie.expires).getTime();
    }
    if (typeof sessionData?.cookie?.maxAge === 'number') {
      return Date.now() + sessionData.cookie.maxAge;
    }
    return null;
  }

  _cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < 60 * 60 * 1000) return;
    this.lastCleanup = now;
    try {
      this.cleanupStmt.run(now);
    } catch {
      // ignore cleanup errors
    }
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      if (!row) return cb(null, null);
      return cb(null, JSON.parse(row.sess));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const expires = this._expires(sessionData);
      this.setStmt.run(sid, JSON.stringify(sessionData), expires);
      this._cleanup();
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      const expires = this._expires(sessionData);
      this.touchStmt.run(expires, sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}

const sessionDbPath = SESSION_DB_PATH || process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'degenerette.sqlite');
fs.mkdirSync(path.dirname(sessionDbPath), { recursive: true });
const sessionDb = new Database(sessionDbPath);
sessionDb.pragma('journal_mode = WAL');
const sessionStore = new SQLiteSessionStore(sessionDb);

app.use(session({
  name: 'discord.sid',
  secret: SESSION_SECRET || 'dev-session-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

// Simple in-memory rate limiter per session. Returns middleware.
// maxRequests within windowMs per session. Keyed on session ID.
function rateLimit(maxRequests, windowMs) {
  const hits = new Map();
  // Periodic cleanup so the map doesn't grow unbounded
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs * 2) hits.delete(key);
    }
  }, windowMs * 5).unref();

  return (req, res, next) => {
    const key = req.sessionID || req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests, slow down' });
      return;
    }
    next();
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    res.status(500).send('Discord OAuth not configured.');
    return;
  }

  const state = crypto.randomUUID();
  req.session.discordState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
    state,
  });

  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code?.toString();
  const state = req.query.state?.toString();

  if (!code || !state || state !== req.session.discordState) {
    res.status(400).send('Invalid OAuth state.');
    return;
  }

  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
    res.status(500).send('Discord OAuth not configured.');
    return;
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    const token = await tokenRes.json();
    if (!token.access_token) {
      res.status(400).send('Failed to get access token.');
      return;
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    });
    const user = await userRes.json();

    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator) % 5}.png`;

    // TODO: upsert user in your DB with initial degenerette score.

    // Join guild (requires bot token + guilds.join scope)
    if (DISCORD_GUILD_ID && DISCORD_BOT_TOKEN) {
      await fetch(`https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${user.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: token.access_token }),
      });
    }

    req.session.user = {
      id: user.id,
      username: (user.global_name || user.username || '').toString(),
      avatarUrl,
    };

    if (req.session.walletAddress) {
      updatePlayerDiscord(req.session.walletAddress, req.session.user);
    }

    res.redirect(`${frontendRedirect}/?discord=connected`);
  } catch (error) {
    console.error('Discord OAuth failed', error);
    res.status(500).send('Discord OAuth failed.');
  }
});

app.get('/auth/discord/me', (req, res) => {
  if (!req.session.user) {
    res.status(401).json({ user: null });
    return;
  }
  res.json({ user: req.session.user });
});

app.post('/auth/discord/logout', (req, res) => {
  req.session.destroy(() => {
    res.status(204).end();
  });
});

function walletRequired(req, res, next) {
  if (!req.session.walletAddress) {
    res.status(401).json({ error: 'Wallet not connected' });
    return;
  }
  next();
}

function discordRequired(req, res, next) {
  if (!req.session.user) {
    res.status(401).json({ error: 'Discord not connected' });
    return;
  }
  next();
}

function isValidTrait(trait) {
  if (!trait) return false;
  const quadrant = Number(trait.quadrant);
  const color = Number(trait.color);
  const symbol = Number(trait.symbol);
  return Number.isInteger(quadrant) && quadrant >= 0 && quadrant < 4
    && Number.isInteger(color) && color >= 0 && color < 8
    && Number.isInteger(symbol) && symbol >= 0 && symbol < 8;
}

function isValidTicket(ticket) {
  if (!ticket || !Array.isArray(ticket.traits) || ticket.traits.length !== 4) return false;
  return ticket.traits.every(isValidTrait);
}

app.post('/api/wallet/nonce', rateLimit(5, 10000), (req, res) => {
  const address = req.body?.address?.toString().toLowerCase();
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }

  const player = getOrCreatePlayer(address);
  const nonce = crypto.randomBytes(16).toString('hex');
  setPlayerNonce(address, nonce);

  const message = `Degenerette login\nNonce: ${nonce}`;
  res.json({ message, address: player.eth_address });
});

app.post('/api/wallet/verify', (req, res) => {
  const address = req.body?.address?.toString().toLowerCase();
  const signature = req.body?.signature?.toString();
  if (!address || !isAddress(address) || !signature) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const player = getPlayerByAddress(address);
  if (!player?.nonce) {
    res.status(400).json({ error: 'No nonce for address' });
    return;
  }

  const message = `Degenerette login\nNonce: ${player.nonce}`;
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  if (recovered.toLowerCase() !== address) {
    res.status(401).json({ error: 'Signature mismatch' });
    return;
  }

  req.session.walletAddress = address;
  clearPlayerNonce(address);

  const referrerCode = req.body?.referrerCode?.toString()?.trim();
  if (referrerCode) {
    setReferrerCode(address, referrerCode);
  }

  if (req.session.user) {
    updatePlayerDiscord(address, req.session.user);
  }

  res.json({ player: sanitizePlayer(getPlayerByAddress(address)) });
});

app.post('/api/wallet/logout', (req, res) => {
  req.session.walletAddress = null;
  res.status(204).end();
});

app.get('/api/player', walletRequired, (req, res) => {
  const player = getPlayerByAddress(req.session.walletAddress);
  if (!player) {
    res.status(404).json({ error: 'Player not found' });
    return;
  }
  res.json({ player: sanitizePlayer(player) });
});

app.get('/api/leaderboard', (_req, res) => {
  const limitParam = Number(_req.query?.limit ?? 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 10;
  const leaderboard = getLeaderboard(limit);
  res.json({ leaderboard });
});

app.get('/api/biggest-wins', (_req, res) => {
  const limitParam = Number(_req.query?.limit ?? 5);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 5) : 5;
  const wins = getBiggestWins(limit);
  res.json({ wins });
});

const MIN_BET_WWXRP = 1;

app.post('/api/spin', walletRequired, rateLimit(10, 5000), (req, res) => {
  const ticket = req.body?.ticket;
  const amount = Number(req.body?.amount);
  const currency = Number(req.body?.currency ?? 3);

  if (!isValidTicket(ticket)) {
    res.status(400).json({ error: 'Invalid ticket' });
    return;
  }
  if (!Number.isFinite(amount) || amount < MIN_BET_WWXRP || !Number.isInteger(amount)) {
    res.status(400).json({ error: `Minimum bet is ${MIN_BET_WWXRP} (whole numbers only)` });
    return;
  }
  if (currency !== 3) {
    res.status(400).json({ error: 'Unsupported currency' });
    return;
  }

  const result = atomicSpin(req.session.walletAddress, (player) =>
    spinFullTicket({ player, ticket, amount, currency })
  );

  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    player: sanitizePlayer(result.player),
    result: result.spin,
  });
});

app.post('/api/referral/create', walletRequired, discordRequired, (req, res) => {
  const player = getPlayerByAddress(req.session.walletAddress);
  if (!player) {
    res.status(404).json({ error: 'Player not found' });
    return;
  }
  const code = ensureReferralCode(player.eth_address);
  if (!code) {
    res.status(500).json({ error: 'Unable to create referral code' });
    return;
  }
  res.json({ referral_code: code });
});

app.post('/api/affiliate/config', walletRequired, discordRequired, (req, res) => {
  const code = req.body?.code;
  const rakebackBps = req.body?.rakebackBps;
  const result = setAffiliateConfig(req.session.walletAddress, { code, rakebackBps });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ player: sanitizePlayer(result.player) });
});

// --- Agent pre-launch registration (no session required, signature is auth) ---

app.post('/api/agent/register', rateLimit(5, 60000), (req, res) => {
  const { address, code, rakebackPct, pledgeEth, message, signature, referrer, timestamp } = req.body || {};

  // Validate fields
  if (!address || typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid address.' });
  }
  const normalizedCode = (code || '').toString().trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(normalizedCode)) {
    return res.status(400).json({ error: 'Code must be 3-12 alphanumeric characters.' });
  }
  const rbPct = Number(rakebackPct) || 0;
  if (!Number.isInteger(rbPct) || rbPct < 0 || rbPct > 25) {
    return res.status(400).json({ error: 'Rakeback must be 0-25.' });
  }
  const pledge = Number(pledgeEth) || 0;
  if (pledge < 0) {
    return res.status(400).json({ error: 'Pledge cannot be negative.' });
  }
  if (!message || !signature || !timestamp) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const lowerAddr = address.toLowerCase();

  // Verify signature
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    return res.status(401).json({ error: 'Invalid signature.' });
  }
  if (recovered.toLowerCase() !== lowerAddr) {
    return res.status(401).json({ error: 'Signature does not match address.' });
  }

  // Verify message contains committed data
  if (!message.includes('"' + normalizedCode + '"')) {
    return res.status(400).json({ error: 'Code mismatch in signed message.' });
  }
  if (!message.includes(rbPct + '% rakeback')) {
    return res.status(400).json({ error: 'Rakeback mismatch in signed message.' });
  }
  if (!message.toLowerCase().includes(lowerAddr)) {
    return res.status(400).json({ error: 'Address mismatch in signed message.' });
  }

  const result = registerAgent({
    address: lowerAddr,
    code: normalizedCode,
    rakebackPct: rbPct,
    pledgeEth: pledge,
    message,
    signature,
    referrer: referrer?.toString().trim() || null,
    timestamp,
  });

  if (result.error) {
    return res.status(409).json({ error: result.error });
  }

  res.json({ ok: true, code: result.code, bumped: result.bumped });
});

app.get('/api/agent/registrations', (_req, res) => {
  const rows = getAgentRegistrations();
  const registrations = rows.map(r => ({
    code: r.code,
    rakebackPct: r.rakeback_pct,
    pledgeEth: r.pledge_eth,
    referrer: r.referrer,
    createdAt: r.created_at,
  }));
  res.json({ count: registrations.length, registrations });
});

app.listen(PORT, () => {
  console.log(`Discord auth server listening on ${PORT}`);
});
