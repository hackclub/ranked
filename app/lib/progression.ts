import { getSql } from "@/db";

// H-Bucks are real budget: coding time already pays out 10 Ħ/hour (see the
// heartbeat route), which keeps the program near Hack Club's $5/hr target.
// Daily challenge Ħ rewards must stay a small top-up on that, not a second
// income stream — so only challenges tied to genuine effort carry Ħ, and the
// rest pay in ELO (free, in-app only). The full 10-challenge pool tops out
// at 35 Ħ/day (~$1.94) no matter how many challenges a player clears.
const challengeConfig = {
  play_matches: { target: 2, rewardElo: 25, rewardHBucks: 0 },
  code_seconds: { target: 10_800, rewardElo: 0, rewardHBucks: 10 },
  add_friends: { target: 2, rewardElo: 40, rewardHBucks: 0 },
  win_matches: { target: 1, rewardElo: 35, rewardHBucks: 0 },
  cast_votes: { target: 3, rewardElo: 0, rewardHBucks: 10 },
  publish_project: { target: 1, rewardElo: 0, rewardHBucks: 15 },
  duo_match: { target: 1, rewardElo: 25, rewardHBucks: 0 },
  duo_invite_sent: { target: 1, rewardElo: 15, rewardHBucks: 0 },
  shop_purchase: { target: 1, rewardElo: 15, rewardHBucks: 0 },
  send_friend_request: { target: 2, rewardElo: 15, rewardHBucks: 0 },
} as const;

export type ChallengeType = keyof typeof challengeConfig;

// The 3 challenges every player starts the day with. The other 7 types are
// the pool that random replacements are drawn from as these (or later
// picks) get completed.
const STARTER_CHALLENGES: ChallengeType[] = ["play_matches", "code_seconds", "add_friends"];
const ACTIVE_SLOTS = 3;
// Never let more than 2 of the 3 active slots be H-Bucks challenges — keeps
// the Ħ payout capped even if a player happens to draw every Ħ challenge.
const MAX_ACTIVE_HBUCKS = 2;

function isHBucksChallenge(type: ChallengeType) {
  return challengeConfig[type].rewardHBucks > 0;
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function addChallengeProgress(userId: string, type: ChallengeType, amount: number) {
  const config = challengeConfig[type];
  const sql = getSql();
  const [, claimResult] = await sql.transaction([
    sql`INSERT INTO daily_challenge_progress
        (user_id, day, type, progress, target, reward_elo, reward_h_bucks)
      VALUES (${userId}, CURRENT_DATE, ${type}::challenge_type, ${amount}, ${config.target}, ${config.rewardElo}, ${config.rewardHBucks})
      ON CONFLICT (user_id, day, type) DO UPDATE SET
        progress = daily_challenge_progress.progress + EXCLUDED.progress, updated_at = NOW()`,
    sql`WITH claim AS (
      UPDATE daily_challenge_progress SET reward_claimed = TRUE, updated_at = NOW()
      WHERE user_id = ${userId} AND day = CURRENT_DATE AND type = ${type}::challenge_type
        AND progress >= target AND reward_claimed = FALSE
      RETURNING reward_elo, reward_h_bucks
    ), ledger AS (
      INSERT INTO elo_transactions (id,user_id,match_id,source_key,before,delta,after,reason)
      SELECT gen_random_uuid()::text,${userId},NULL,'daily:'||CURRENT_DATE||':'||${type},u.elo,claim.reward_elo,u.elo+claim.reward_elo,'daily_challenge'
      FROM claim CROSS JOIN users u WHERE u.id=${userId} AND claim.reward_elo<>0
      ON CONFLICT (user_id,source_key) DO NOTHING RETURNING after
    )
    UPDATE users SET
      elo = COALESCE((SELECT after FROM ledger), elo),
      h_bucks = h_bucks + COALESCE((SELECT reward_h_bucks FROM claim), 0), updated_at = NOW()
    WHERE id = ${userId} AND EXISTS (SELECT 1 FROM claim)
    RETURNING id
    `,
  ]);
  if (claimResult.length) await refillDailyChallenges(userId);
}

export async function ensureDailyChallenges(userId: string) {
  for (const type of STARTER_CHALLENGES) {
    const config = challengeConfig[type];
    await getSql()`
      INSERT INTO daily_challenge_progress
        (user_id, day, type, progress, target, reward_elo, reward_h_bucks)
      VALUES (${userId}, CURRENT_DATE, ${type}::challenge_type, 0, ${config.target}, ${config.rewardElo}, ${config.rewardHBucks})
      ON CONFLICT DO NOTHING
    `;
  }
  await refillDailyChallenges(userId);
}

// Keeps up to ACTIVE_SLOTS unclaimed challenges available per day. Called
// whenever a challenge is claimed so a fresh random one (from types not yet
// seen today) immediately takes its place.
export async function refillDailyChallenges(userId: string) {
  const sql = getSql();
  const today = await sql`SELECT type, reward_claimed AS "rewardClaimed"
    FROM daily_challenge_progress WHERE user_id = ${userId} AND day = CURRENT_DATE`;
  const usedTypes = new Set(today.map(row => row.type as ChallengeType));
  const active = today.filter(row => !row.rewardClaimed);
  const need = ACTIVE_SLOTS - active.length;
  if (need <= 0) return;
  let activeHBucksCount = active.filter(row => isHBucksChallenge(row.type as ChallengeType)).length;

  const pool = shuffled((Object.keys(challengeConfig) as ChallengeType[]).filter(type => !usedTypes.has(type)));
  const picks: ChallengeType[] = [];
  for (const type of pool) {
    if (picks.length >= need) break;
    if (isHBucksChallenge(type) && activeHBucksCount >= MAX_ACTIVE_HBUCKS) continue;
    picks.push(type);
    if (isHBucksChallenge(type)) activeHBucksCount++;
  }
  for (const type of picks) {
    const config = challengeConfig[type];
    await sql`INSERT INTO daily_challenge_progress
        (user_id, day, type, progress, target, reward_elo, reward_h_bucks)
      VALUES (${userId}, CURRENT_DATE, ${type}::challenge_type, 0, ${config.target}, ${config.rewardElo}, ${config.rewardHBucks})
      ON CONFLICT DO NOTHING`;
  }
}
