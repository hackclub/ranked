import { getSql } from "@/db";

const challengeConfig = {
  play_matches: { target: 2, rewardElo: 25, rewardHBucks: 0 },
  code_seconds: { target: 10_800, rewardElo: 0, rewardHBucks: 30 },
  add_friends: { target: 2, rewardElo: 40, rewardHBucks: 0 },
} as const;

export type ChallengeType = keyof typeof challengeConfig;

export async function addChallengeProgress(userId: string, type: ChallengeType, amount: number) {
  const config = challengeConfig[type];
  const sql = getSql();
  await sql.transaction([
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
    `,
  ]);
}

export async function ensureDailyChallenges(userId: string) {
  for (const [type, config] of Object.entries(challengeConfig)) {
    await getSql()`
      INSERT INTO daily_challenge_progress
        (user_id, day, type, progress, target, reward_elo, reward_h_bucks)
      VALUES (${userId}, CURRENT_DATE, ${type}::challenge_type, 0, ${config.target}, ${config.rewardElo}, ${config.rewardHBucks})
      ON CONFLICT DO NOTHING
    `;
  }
}
