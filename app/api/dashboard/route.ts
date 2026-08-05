import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { ensureDailyChallenges } from "@/app/lib/progression";
import { getVoteGate } from "@/app/lib/vote-gate";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensureDailyChallenges(user.id);
  const sql = getSql();
  const [friends, recent, challenges, rank] = await sql.transaction([
    sql`SELECT u.id, u.name, u.slack_id AS "slackId", u.avatar, f.id AS "friendshipId", f.status,
      CASE WHEN f.addressee_id = ${user.id} THEN TRUE ELSE FALSE END AS "incoming"
      FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ${user.id} THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ${user.id} OR f.addressee_id = ${user.id}) AND f.status IN ('accepted','pending')
      ORDER BY f.updated_at DESC LIMIT 12`,
    sql`SELECT m.id, m.theme, m.mode, m.status, m.winning_team AS "winningTeam", m.created_at AS "createdAt",
      json_agg(json_build_object('id', u.id, 'name', u.name, 'team', mp.team)) FILTER (WHERE u.id <> ${user.id}) AS opponents
      FROM match_players mine JOIN matches m ON m.id = mine.match_id
      JOIN match_players mp ON mp.match_id = m.id JOIN users u ON u.id = mp.user_id
      WHERE mine.user_id = ${user.id}
      GROUP BY m.id ORDER BY m.created_at DESC LIMIT 8`,
    sql`SELECT type, progress, target, reward_elo AS "rewardElo", reward_h_bucks AS "rewardHBucks", reward_claimed AS "rewardClaimed"
      FROM daily_challenge_progress WHERE user_id = ${user.id} AND day = CURRENT_DATE ORDER BY type`,
    sql`SELECT (COUNT(*) FILTER (WHERE elo > ${user.elo} OR (elo = ${user.elo} AND matches_played > ${user.matchesPlayed})))::int + 1 AS rank FROM users`,
  ]);
  const voteGate = await getVoteGate(user.id, user.matchesPlayed);
  const globalRank = Number((rank[0] as { rank: number } | undefined)?.rank ?? 0) || null;
  return NextResponse.json({ user, friends, recent, challenges, voteGate, globalRank });
}
