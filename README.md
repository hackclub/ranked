# Ranked

Competitive and cooperative livecoding for Hack Club builders. Ranked includes PostgreSQL-backed accounts, placement/ELO matchmaking, solo and duo matches, community voting, progression, friends, rewards, Hack Club OAuth, GitHub Pages publishing, team-scoped Yjs/Monaco collaboration, and peer-to-peer WebRTC calls.

## Local setup

1. Create a PostgreSQL database (Neon works well) and copy its pooled connection string to `DATABASE_URL` in `.env.local`.
2. Fill in the remaining provider values from `.env.example`.
3. Run `npm run db:migrate` once, then `npm run dev`.
4. Open `http://localhost:3000`.

All player state lives in PostgreSQL: profiles and avatars, queue entries, teams, match timers, snapshots, coding time, H-Bucks, daily progress, friends, votes, publications, orders, and an immutable ELO transaction ledger. ELO is calculated and applied on the server after independent votes; clients never submit rating changes.

To permanently remove every user and all gameplay data while preserving the database schema and migration history, point `DATABASE_URL` at the intended database and run:

```bash
npm run db:wipe-users -- --confirm WIPE_ALL_USER_DATA
```

The command prints the database hostname and name before deleting anything. It does not delete published GitHub repositories or external Liveblocks rooms.

## Vercel deployment

The project uses vinext with Nitro's Vercel adapter. `vercel.json` runs the Vercel preset, which emits the Build Output API bundle in `.vercel/output` with a server function for the homepage and every API route.

In Vercel, use the **Other** framework preset and do not override the output directory. Add all values from `.env.example` to the Vercel project, using the production domain for `APP_BASE_URL`, `AUTH_REDIRECT_URI`, and `GITHUB_REDIRECT_URI`. Apply the PostgreSQL migrations once before accepting users. OAuth providers must list the exact production callbacks.

## Hack Club Auth

Create a developer app at `https://auth.hackclub.com/developer/apps` and configure:

- Callback: `http://localhost:3000/api/auth/hackclub/callback`
- Scopes: `email name verification_status slack_id`
- Environment: `AUTH_CLIENTID`, `AUTH_CLIENTSECRET`, `AUTH_SESSION_SECRET`

`AUTH_SESSION_SECRET` should be at least 32 random characters. It encrypts the HTTP-only session that contains account connections.

## GitHub publishing

Create a GitHub OAuth App and configure:

- Callback: `http://localhost:3000/api/auth/github/callback`
- Environment: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- Scope: `repo` (GitHub requires this classic OAuth scope to configure Pages, even though Ranked creates a public repository)

When the timer ends, every participant chooses a build name. Ranked commits the build into a folder of that name inside a single `hackclubranked` repository in the participant's connected GitHub account — creating that repo and enabling GitHub Pages from its `main` branch the first time a player publishes — with the deployable `index.html`, a per-build README, `.nojekyll`, and the original HTML/CSS/JS source files. Every later match adds another folder to the same repo instead of creating a new one. Duo teammates publish the same finished team build independently to their own accounts; voting opens after every player has published.

## Realtime rooms and calls

Create a Liveblocks project and set `LIVEBLOCKS_SECRET_KEY`. Ranked verifies match membership before authorizing rooms. A match has one call room for all players and a separate code room per team, so opponents cannot read or edit each other’s source. Monaco files synchronize with Liveblocks’ Yjs provider, and call-room events carry WebRTC offer/answer/ICE signaling.

Audio and video travel directly between peers. Google's public STUN servers are included for local testing. For reliable production calls across restrictive networks, fill in the optional TURN variables in `.env.local`.

For a local multiplayer test, sign in as separate Hack Club users in separate browser profiles, select the same mode and duration, and ready up. Ranked assigns teams transactionally once two solo or four duo players are queued.

## Other services

- `SLACK_BOT_TOKEN`: optional Slack-name lookup; use `users:read`. The other person must have signed into Ranked before they can be friended.
- `VOTES_TO_FINALIZE`: community votes needed before server-side ELO settlement; defaults to `3`.
- `NEXT_PUBLIC_TURN_*`: optional but strongly recommended for reliable WebRTC outside friendly networks.
- Shop redemptions create `pending` PostgreSQL orders and atomically deduct H-Bucks. Fulfillment/approval remains an admin operation, not an automatic hardware purchase.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
npm test
```
