import { pathToFileURL } from "node:url";
import { neon, neonConfig } from "@neondatabase/serverless";
import { config } from "dotenv";

// Mirrors db/index.ts: against a local Postgres, Neon's HTTP driver has to
// be routed through local-neon-http-proxy (see docker-compose.yml) instead
// of resolving Neon's own cloud endpoint.
function isLocalDatabaseUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function connect(databaseUrl) {
  if (isLocalDatabaseUrl(databaseUrl)) {
    neonConfig.fetchEndpoint = (host) => `http://${host}:4444/sql`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.poolQueryViaFetch = true;
  }
  return neon(databaseUrl);
}

/**
 * daily_challenge_progress snapshots reward_elo/reward_h_bucks onto the row
 * the moment a challenge is assigned (see ensureDailyChallenges /
 * refillDailyChallenges in app/lib/progression.ts). Bumping a reward in
 * challengeConfig only affects challenges assigned from that point on —
 * anyone who already had today's challenge sitting unclaimed keeps the old
 * snapshotted number until they claim it or the day rolls over.
 *
 * This resyncs any unclaimed *today* row whose stored reward doesn't match
 * challengeConfig, so a reward bump takes effect immediately instead of
 * waiting on a claim or the next UTC day. Keep REWARDS in sync with
 * challengeConfig in app/lib/progression.ts by hand — it's duplicated here
 * because this script runs outside the Next/TS build.
 */
const REWARDS = {
  play_matches: { rewardElo: 25, rewardHBucks: 0 },
  code_seconds: { rewardElo: 0, rewardHBucks: 30 },
  add_friends: { rewardElo: 40, rewardHBucks: 0 },
  win_matches: { rewardElo: 35, rewardHBucks: 0 },
  cast_votes: { rewardElo: 0, rewardHBucks: 10 },
  publish_project: { rewardElo: 0, rewardHBucks: 15 },
  duo_match: { rewardElo: 25, rewardHBucks: 0 },
  duo_invite_sent: { rewardElo: 15, rewardHBucks: 0 },
  shop_purchase: { rewardElo: 15, rewardHBucks: 0 },
  send_friend_request: { rewardElo: 15, rewardHBucks: 0 },
};

export async function resyncDailyChallengeRewards(sql) {
  let updated = 0;
  for (const [type, reward] of Object.entries(REWARDS)) {
    const rows = await sql`
      UPDATE daily_challenge_progress
      SET reward_elo = ${reward.rewardElo}, reward_h_bucks = ${reward.rewardHBucks}, updated_at = NOW()
      WHERE day = CURRENT_DATE AND type = ${type}::challenge_type AND reward_claimed = FALSE
        AND (reward_elo <> ${reward.rewardElo} OR reward_h_bucks <> ${reward.rewardHBucks})
      RETURNING user_id
    `;
    updated += rows.length;
  }
  return { updatedCount: updated };
}

async function runFromCommandLine() {
  config({ path: ".env.local" });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not configured. Set it in .env.local or the environment.",
    );
    process.exitCode = 1;
    return;
  }

  let target;
  try {
    const parsed = new URL(databaseUrl);
    target = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exitCode = 1;
    return;
  }

  console.log(`Resyncing today's unclaimed daily challenge rewards on ${target}...`);
  const result = await resyncDailyChallengeRewards(connect(databaseUrl));
  console.log(`Done. Updated ${result.updatedCount} row(s).`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runFromCommandLine().catch((error) => {
    console.error("Resync failed.", error);
    process.exitCode = 1;
  });
}
