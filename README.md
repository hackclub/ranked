# Ranked

Competitive and cooperative livecoding for Hack Club builders. Ranked includes PostgreSQL-backed accounts, placement/ELO matchmaking, solo and duo matches, community voting, progression, friends, rewards, Hack Club OAuth, GitHub Pages publishing, team-scoped Yjs/Monaco collaboration, and peer-to-peer WebRTC calls.

## Local setup

1. Create a PostgreSQL database (Neon works well) and copy its pooled connection string to `DATABASE_URL` in `.env.local`.
2. Fill in the remaining provider values from `.env.example`.
3. Run `npm run db:migrate` once, then `npm run dev`.
4. Open `http://localhost:3000`.

`npm run dev` listens on this machine only. To test a call between two devices
on the same network, use `npm run dev:lan`. It serves the app, running with
whatever secrets are in `.env.local`, to everything on that network, so use it
only on a network you trust.

Admin tools and recording review are granted by email through `ADMIN_EMAILS`
and `RECORDING_REVIEWER_EMAILS` (comma-separated). Both are empty by default,
which means nobody has either role.

All player state lives in PostgreSQL: profiles and avatars, queue entries, teams, match timers, snapshots, coding time, H-Bucks, daily progress, friends, votes, publications, orders, and an immutable ELO transaction ledger. ELO is calculated and applied on the server after independent votes; clients never submit rating changes.

To permanently remove every user and all gameplay data while preserving the database schema and migration history, point `DATABASE_URL` at the intended database and run:

```bash
npm run db:wipe-users -- --confirm WIPE_ALL_USER_DATA
```

The command prints the database hostname and name before deleting anything. It does not delete published GitHub repositories or external Liveblocks rooms.

To permanently remove every match while preserving user accounts and their
current ELO, balances, coding totals, challenges, friendships, connections, and
shop orders, run:

```bash
npm run db:clear-matches -- --confirm CLEAR_ALL_MATCHES
```

This also clears the matchmaking queue. Match players, votes, ELO ledger rows,
publications, reports, and snapshots are removed automatically through their
match foreign keys. Published GitHub repositories, Airtable submissions, and
external Liveblocks rooms are not deleted.

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

Create a GitHub App and configure its user authorization flow:

- Callback: `http://localhost:3000/api/auth/github/callback`
- Environment: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_APP_SLUG` (only to override the default `hack-club-ranked`)
- Repository permissions: **Contents — Read and write**, **Pages — Read and write**, and **Administration — Read and write**
- Enable **Request user authorization (OAuth) during installation**
- Use the app's **Client ID**, not its numeric App ID. No classic OAuth `repo` scope is used.
- Keep expiring user-to-server tokens enabled. Ranked stores and rotates the refresh token automatically.

Installing the app and authorizing it are two different things on GitHub: `https://github.com/login/oauth/authorize` only establishes who the player is, and the user access token it returns can read their profile but cannot see a single repository. Only an installation (`https://github.com/apps/<slug>/installations/new`) asks for the `hackclubranked` repo and the repository permissions above. Both are required, in that order: `/api/auth/github/start` authorizes, and the callback then sends players on to `?mode=install` when the access check finds the app isn't installed.

Leading with the installation URL instead looks tempting and is wrong. `installations/new` sends an account that already has the app to its existing installation's configure page, which issues no authorization code — so an install-first flow strands every returning player whose token expired, mid-publish. The authorize URL issues a code whether or not the app is installed, which makes it the only safe first hop. A one-shot `ranked_github_install_prompted` cookie stops the install detour from repeating for someone who cancels it.

With **Request user authorization (OAuth) during installation** enabled, GitHub returns from the installation straight to the callback with an authorization code. The callback also handles arriving with only an `installation_id` (someone installing from the app's page, or that setting being off) by running the authorization leg itself.

Because a code from the installation flow is issued without a `code_challenge`, it must be exchanged without a `code_verifier`; codes from `?mode=authorize` keep their PKCE pair. The callback tells them apart with a short-lived `ranked_github_flow` cookie.

Matchmaking will not hand out a match to a player who can't publish one: `/api/matchmaking/queue`'s POST runs `rankedPublishBlock` and answers `github_install_required` (with the specific problem and the URL that fixes it) alongside its existing Hackatime and voting gates. That is what converts existing players — the check happens when they ready up, a 30-second detour, instead of after a finished build has nowhere to go. It deliberately fails open: an unreachable GitHub, or an access token too near expiry to check without spending its rotating refresh token, lets them queue rather than holding matchmaking closed.

One trap in that check: `GET /user/installations` lists every installation the player can *see*, which for a Hack Club member includes the app installed on the **hackclub org**. Matching on the app alone can pick that one — the wrong id to link to (an org installation lives under `/organizations/<org>/settings/installations`) and the wrong permissions to compare against, which manufactures a pending approval with nothing to approve. A player's `hackclubranked` repo is always personal, so only an installation whose `target_type` is `User` and whose account is that player counts; an org-only installation reads as not installed.

`/api/github/installation` reports whether a connection can actually publish — installed, holding the current repository permissions (an installation stays on its original permissions until its owner approves ones the app added later), and able to see a `hackclubranked` repo. Onboarding will not move past the GitHub step until that check passes, so a player cannot reach the end of a match only to find the app has no access.

When the timer ends, every participant chooses a build name. Ranked commits the build into a folder of that name inside a single `hackclubranked` repository in the participant's connected GitHub account and enables GitHub Pages from its `main` branch. GitHub's Pages creation endpoint requires both Pages and Administration write permissions; Administration remains limited to the selected `hackclubranked` repository. Existing installations must approve newly-added repository permissions before they take effect. The player creates that repository from the Ranked template and grants the GitHub App access to it first. Every later match adds another folder to the same repo instead of creating a new one. Duo teammates publish the same finished team build independently to their own accounts; voting opens after every player has published.

Every publish also regenerates a root `index.html` in that repo — a directory page linking to every folder (build) the player has published, generated from the `publications` table rather than by listing the repo. This gives each player one stable GitHub Pages URL (`https://<login>.github.io/hackclubranked/`) that lists all of their builds, alongside each individual build's own page.

## Realtime rooms and calls

Create a Liveblocks project and set `LIVEBLOCKS_SECRET_KEY`. Ranked verifies match membership before authorizing rooms. A match has one call room for all players and a separate code room per team, so opponents cannot read or edit each other’s source. Monaco files synchronize with Liveblocks’ Yjs provider, and call-room events carry WebRTC offer/answer/ICE signaling.

By default audio and video travel directly between peers, using Google's public STUN servers. For reliable production calls across restrictive networks, configure a TURN server with the `TURN_*` (or `CLOUDFLARE_TURN_*`) variables in `.env.example`. They are server-side only: `/api/matches/[matchId]/ice-servers` issues short-lived credentials to players in a match, so no TURN credential is built into the client.

A direct peer-to-peer call reveals each player's IP address to the others in it. Set `TURN_RELAY_ONLY=true` to route all call media through TURN instead, which hides them from each other at the cost of relaying (and paying for) every call.

### Private safety recordings

Every participant must explicitly consent before matchmaking. During a match,
their local camera and microphone stream is split into short, independently
playable clips and uploaded through Ranked's authenticated server to a
**private** Cloudflare R2 bucket. R2 credentials never reach the browser.
Only the accounts listed in `RECORDING_REVIEWER_EMAILS` pass the independent,
server-side reviewer allowlist; it is separate from `ADMIN_EMAILS`, so being an
admin does not grant access to recordings. Reviewer playback is proxied through
an authenticated, no-store API; the bucket must not have public access enabled.

The recording is made by each player's own browser, so the server cannot force
it to happen, but it does check that it is happening. The call is open only
during the match's timed window, and each player's client leaves it when the
timer ends. While a match is live the server expects a clip from every player
at least once a minute; a player whose clips stop arriving is flagged in the
audit log (`recording.missing`), is refused new call tokens, and is told to
stop sending their camera and microphone to the other players until clips
arrive again. A deliberately modified client can still ignore that instruction
for a call it has already joined. Closing that gap completely means recording
on a media server instead of in the browser. Set `RECORDING_ENFORCEMENT=off`
only to keep calls working through a storage outage.

Configure these environment values:

- `R2_ACCOUNT_ID`: Cloudflare account ID.
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`: an R2 token restricted to Object Read & Write on the recordings bucket only.
- `R2_RECORDINGS_BUCKET`: the private bucket name.
- `CRON_SECRET`: a random value of at least 32 characters for the retention job.

No R2 CORS rule is required: browsers upload to Ranked's same-origin API, and
only the authenticated server communicates with the private bucket.

Add an R2 Object Lifecycle Rule for the `recordings/` prefix that expires
objects after **10 days**. This is defense in depth alongside the authenticated
daily Vercel retention job in `vercel.json`, which removes expired R2 objects
and PostgreSQL metadata. The private dashboard is available at
`/reviewer/recordings` after signing in through Hack Club Auth with one of the
two allowlisted addresses. Dashboard opens and playback starts are written to
the audit log.

Because recording laws and requirements for minors differ by jurisdiction, the
built-in affirmative consent gate is a technical safeguard, not a substitute
for legal review of the final consent language and privacy policy before launch.

For a local multiplayer test, sign in as separate Hack Club users in separate browser profiles, select the same mode and duration, and ready up. Ranked assigns teams transactionally once two solo or four duo players are queued.

## Other services

- The friend-add picker searches Ranked accounts directly from Postgres (`users.name`/`email`, populated at Hack Club sign-in) — no Slack API calls. Typing a handle that doesn't match anyone copies a Slack DM invite to your clipboard to send yourself.
- `VOTES_TO_FINALIZE`: community votes needed before server-side ELO settlement; defaults to `3`.
- `TURN_*` / `CLOUDFLARE_TURN_*`: optional but strongly recommended for reliable WebRTC outside friendly networks; `TURN_RELAY_ONLY=true` additionally keeps players' IP addresses private from each other.
- Shop redemptions create `pending` PostgreSQL orders and atomically deduct H-Bucks. Fulfillment/approval remains an admin operation, not an automatic hardware purchase.
- The shipping address on an order is stored encrypted (AES-GCM) and is never returned by the API. To fulfil orders, run `npm run shop:orders` with the app's secrets in `.env.local`; it prints each open order with its decrypted address. Addresses saved before encryption was added are encrypted once with `npm run shop:encrypt-shipping -- --confirm encrypt-shipping`.
- Mutating and outbound-fetching routes are rate limited per account with counters in the `rate_limits` table (`app/lib/rate-limit.ts`). Limits by IP address for signed-out traffic are left to the platform's firewall.
- The daily cron in `vercel.json` (authenticated with `CRON_SECRET`) also closes matches left unfinished for more than 24 hours after their timer: a match both teams published goes to community voting, anything else is cancelled with no ELO change. Without it a single player who never publishes would hold a match open indefinitely.
- Tailwind's browser build is vendored at `app/lib/vendor/` (see the README there). Previews load it from this app and every published build carries its own copy, so player sites depend on no third-party CDN.
- An opponent's live preview is a still, script-free copy of their rendered page, and loads nothing from the network. Images and web fonts hosted elsewhere therefore don't appear in that peek; they do on the published site voters see.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
npm test
```
