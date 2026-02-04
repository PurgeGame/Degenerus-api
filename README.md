# Degenerus Demo API

Express + SQLite backend for the Degenerette demo. Handles:
- Wallet auth (sign-in via nonce + signature)
- Discord OAuth connect + optional server auto-join
- Leaderboard + spin history
- Affiliate code + rakeback config

## Local dev

```
cp .env.example .env
npm install
npm run dev
```

Default local URL: http://localhost:8787

## Environment variables

Required for production:
- `NODE_ENV=production`
- `PORT=8787`
- `DATABASE_PATH=/data/degenerette.sqlite`
- `SESSION_DB_PATH=/data/degenerette.sqlite`
- `FRONTEND_ORIGIN=https://degener.us,https://www.degener.us`
- `FRONTEND_REDIRECT=https://degener.us`
- `SESSION_SECRET=...`

Discord (required for connect + auto-join):
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI=https://api.degener.us/auth/discord/callback`
- `DISCORD_GUILD_ID`
- `DISCORD_BOT_TOKEN`

## Deploy (Fly.io)

This repo ships with a `fly.toml` and `Dockerfile`.

1) Install flyctl: https://fly.io/docs/flyctl/install/
2) Login: `fly auth login`
3) From this folder:

```
fly launch
fly volumes create degenerette_data --size 1 --region iad
fly secrets set \
  NODE_ENV=production \
  PORT=8787 \
  DATABASE_PATH=/data/degenerette.sqlite \
  FRONTEND_ORIGIN=https://degener.us,https://www.degener.us \
  FRONTEND_REDIRECT=https://degener.us \
  SESSION_SECRET=CHANGE_ME \
  DISCORD_CLIENT_ID=... \
  DISCORD_CLIENT_SECRET=... \
  DISCORD_REDIRECT_URI=https://api.degener.us/auth/discord/callback \
  DISCORD_GUILD_ID=... \
  DISCORD_BOT_TOKEN=...
fly deploy
```

4) Add custom domain for the API:
```
fly certs add api.degener.us
```

Then add the DNS records Fly provides in Cloudflare.

## API endpoints

- `GET /health`
- `GET /api/player`
- `POST /api/wallet/nonce`
- `POST /api/wallet/verify`
- `POST /api/wallet/logout`
- `POST /api/spin`
- `GET /api/leaderboard`
- `POST /api/referral/create`
- `POST /api/affiliate/config`
- `GET /auth/discord`
- `GET /auth/discord/callback`
- `GET /auth/discord/me`
- `POST /auth/discord/logout`
