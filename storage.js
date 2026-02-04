import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'degenerette.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eth_address TEXT UNIQUE NOT NULL,
    discord_id TEXT,
    discord_name TEXT,
    discord_avatar TEXT,
    balance_wwxrp REAL NOT NULL DEFAULT 1000,
    activity_score_bps INTEGER NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referrer_code TEXT,
    affiliate_rakeback_bps INTEGER NOT NULL DEFAULT 0,
    referral_locked INTEGER NOT NULL DEFAULT 0,
    nonce TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    bet_amount REAL NOT NULL,
    payout REAL NOT NULL,
    net REAL NOT NULL,
    matches INTEGER NOT NULL,
    player_ticket TEXT NOT NULL,
    house_ticket TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );
`);

function ensurePlayerColumns() {
  const columns = db.prepare('PRAGMA table_info(players)').all().map((col) => col.name);
  if (!columns.includes('affiliate_rakeback_bps')) {
    db.exec('ALTER TABLE players ADD COLUMN affiliate_rakeback_bps INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.includes('referral_locked')) {
    db.exec('ALTER TABLE players ADD COLUMN referral_locked INTEGER NOT NULL DEFAULT 0');
  }
}

ensurePlayerColumns();

function generateReferralCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function serializePlayer(row) {
  if (!row) return null;
  return {
    id: row.id,
    eth_address: row.eth_address,
    discord_id: row.discord_id,
    discord_name: row.discord_name,
    discord_avatar: row.discord_avatar,
    balance_wwxrp: row.balance_wwxrp,
    activity_score_bps: row.activity_score_bps,
    referral_code: row.referral_code,
    referrer_code: row.referrer_code,
    affiliate_rakeback_bps: row.affiliate_rakeback_bps,
    referral_locked: row.referral_locked,
    nonce: row.nonce,
  };
}

export function sanitizePlayer(row) {
  if (!row) return null;
  const { nonce, ...safe } = row;
  return safe;
}

export function getPlayerByAddress(address) {
  const row = db.prepare('SELECT * FROM players WHERE eth_address = ?').get(address);
  return serializePlayer(row);
}

export function getPlayerByReferralCode(code) {
  const row = db.prepare('SELECT * FROM players WHERE referral_code = ?').get(code);
  return serializePlayer(row);
}

export function getLeaderboard(limit = 10) {
  const rows = db.prepare(`
    SELECT eth_address, discord_name, discord_avatar, balance_wwxrp
    FROM players
    WHERE discord_id IS NOT NULL AND discord_id != ''
    ORDER BY balance_wwxrp DESC, updated_at DESC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    eth_address: row.eth_address,
    discord_name: row.discord_name,
    discord_avatar: row.discord_avatar,
    balance_wwxrp: row.balance_wwxrp,
  }));
}

export function getOrCreatePlayer(address) {
  const existing = getPlayerByAddress(address);
  if (existing) return existing;

  let referral = generateReferralCode();
  const insert = db.prepare(`
    INSERT INTO players (eth_address, referral_code)
    VALUES (?, ?)
  `);
  while (true) {
    try {
      insert.run(address, referral);
      break;
    } catch (err) {
      referral = generateReferralCode();
    }
  }

  return getPlayerByAddress(address);
}

export function ensureReferralCode(address) {
  const player = getPlayerByAddress(address);
  if (!player) return null;
  if (player.referral_code) return player.referral_code;

  let referral = generateReferralCode();
  while (true) {
    try {
      db.prepare(`
        UPDATE players
        SET referral_code = ?, updated_at = datetime('now')
        WHERE eth_address = ? AND referral_code IS NULL
      `).run(referral, address);
      break;
    } catch (err) {
      referral = generateReferralCode();
    }
  }
  return getPlayerByAddress(address)?.referral_code ?? null;
}

export function setAffiliateConfig(address, { code, rakebackBps }) {
  const player = getPlayerByAddress(address);
  if (!player) {
    return { ok: false, error: 'Player not found' };
  }

  const normalized = code?.toString().trim().toUpperCase();
  if (!normalized || !/^[A-Z0-9]{3,12}$/.test(normalized)) {
    return { ok: false, error: 'Affiliate code must be 3-12 letters or numbers' };
  }

  const allowedBps = new Set([0, 500, 1000, 1500, 2000, 2500]);
  const parsedBps = Number(rakebackBps);
  if (!Number.isInteger(parsedBps) || !allowedBps.has(parsedBps)) {
    return { ok: false, error: 'Invalid rakeback selection' };
  }

  const existing = getPlayerByReferralCode(normalized);
  if (existing && existing.eth_address !== address) {
    return { ok: false, error: 'Affiliate code already taken' };
  }

  if (player.referral_locked) {
    return { ok: false, error: 'Affiliate settings are already locked' };
  }

  db.prepare(`
    UPDATE players
    SET referral_code = ?,
        affiliate_rakeback_bps = ?,
        referral_locked = 1,
        updated_at = datetime('now')
    WHERE eth_address = ?
  `).run(normalized, parsedBps, address);

  return { ok: true, player: getPlayerByAddress(address) };
}

export function updatePlayerDiscord(address, user) {
  db.prepare(`
    UPDATE players
    SET discord_id = ?, discord_name = ?, discord_avatar = ?, updated_at = datetime('now')
    WHERE eth_address = ?
  `).run(user.id, user.username, user.avatarUrl, address);
}

export function setPlayerNonce(address, nonce) {
  db.prepare(`
    UPDATE players
    SET nonce = ?, updated_at = datetime('now')
    WHERE eth_address = ?
  `).run(nonce, address);
}

export function clearPlayerNonce(address) {
  db.prepare(`
    UPDATE players
    SET nonce = NULL, updated_at = datetime('now')
    WHERE eth_address = ?
  `).run(address);
}

export function updatePlayerState(address, { balance, activityScoreBps }) {
  db.prepare(`
    UPDATE players
    SET balance_wwxrp = ?, activity_score_bps = ?, updated_at = datetime('now')
    WHERE eth_address = ?
  `).run(balance, activityScoreBps, address);
  return getPlayerByAddress(address);
}

export function setReferrerCode(address, referrerCode) {
  if (!referrerCode) return;
  const normalized = referrerCode.trim().toUpperCase();
  if (!normalized) return;
  const referrer = getPlayerByReferralCode(normalized);
  if (!referrer || referrer.eth_address === address) return;
  db.prepare(`
    UPDATE players
    SET referrer_code = ?, updated_at = datetime('now')
    WHERE eth_address = ? AND referrer_code IS NULL
  `).run(normalized, address);
}

export function recordSpin(playerId, spin) {
  const latest = spin.results?.[spin.results.length - 1];
  const matches = latest?.matches ?? 0;
  const playerTicket = JSON.stringify(latest?.playerTicket ?? {});
  const houseTicket = JSON.stringify(latest?.resultTicket ?? {});
  db.prepare(`
    INSERT INTO spins (player_id, bet_amount, payout, net, matches, player_ticket, house_ticket)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(playerId, spin.totalBet, spin.totalPayout, spin.netResult, matches, playerTicket, houseTicket);
}
