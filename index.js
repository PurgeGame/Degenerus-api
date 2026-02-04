import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import dotenv from 'dotenv';
import { isAddress, verifyMessage } from 'ethers';
import {
  getOrCreatePlayer,
  getPlayerByAddress,
  updatePlayerDiscord,
  setPlayerNonce,
  clearPlayerNonce,
  updatePlayerState,
  recordSpin,
  sanitizePlayer,
  setReferrerCode,
  ensureReferralCode,
  setAffiliateConfig,
  getLeaderboard,
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
  SESSION_SECRET,
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

const allowedOrigins = (FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

app.use(session({
  name: 'discord.sid',
  secret: SESSION_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
  },
}));

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
      username: `${user.username}${user.discriminator ? `#${user.discriminator}` : ''}`,
      avatarUrl,
    };

    if (req.session.walletAddress) {
      updatePlayerDiscord(req.session.walletAddress, req.session.user);
    }

    const redirect = FRONTEND_ORIGIN || 'http://localhost:5173';
    res.redirect(`${redirect}/?discord=connected`);
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
  if (typeof ticket.special !== 'number') return false;
  if (ticket.special < 1 || ticket.special > 3) return false;
  return ticket.traits.every(isValidTrait);
}

app.post('/api/wallet/nonce', (req, res) => {
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

app.post('/api/spin', walletRequired, (req, res) => {
  const player = getPlayerByAddress(req.session.walletAddress);
  if (!player) {
    res.status(404).json({ error: 'Player not found' });
    return;
  }

  const ticket = req.body?.ticket;
  const amount = Number(req.body?.amount);
  const currency = Number(req.body?.currency ?? 3);

  if (!isValidTicket(ticket)) {
    res.status(400).json({ error: 'Invalid ticket' });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }
  if (currency !== 3) {
    res.status(400).json({ error: 'Unsupported currency' });
    return;
  }

  const result = spinFullTicket({
    player,
    ticket,
    amount,
    currency,
  });

  if (!result) {
    res.status(400).json({ error: 'Insufficient balance' });
    return;
  }

  const updated = updatePlayerState(player.eth_address, {
    balance: result.player.balance_wwxrp,
    activityScoreBps: result.player.activity_score_bps,
  });

  recordSpin(updated.id, result.spin);

  res.json({
    player: sanitizePlayer(updated),
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

app.listen(PORT, () => {
  console.log(`Discord auth server listening on ${PORT}`);
});
