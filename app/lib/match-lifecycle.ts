import { addChallengeProgress } from "@/app/lib/progression";
import { getSql } from "@/db";

export type MatchTeam = "blue" | "red";
export type MatchEndReason = "forfeit" | "disconnect";

export type MatchOutcome = {
  status: string;
  winningTeam: MatchTeam | null;
  endReason: string | null;
  forfeitedBy: string | null;
  forfeitingTeam: MatchTeam | null;
  endedAt: string | null;
  remainingSeconds: number;
};

export type DisconnectNotice = {
  userId: string;
  name: string;
  team: MatchTeam;
  expiresAt: string;
  secondsRemaining: number;
};

export async function matchOutcome(matchId: string): Promise<MatchOutcome | null> {
  const rows = await getSql()`SELECT status, winning_team AS "winningTeam", end_reason AS "endReason",
      forfeited_by AS "forfeitedBy", forfeiting_team AS "forfeitingTeam", ended_at AS "endedAt",
      GREATEST(0,CEIL(EXTRACT(EPOCH FROM (ends_at-NOW()))))::int AS "remainingSeconds"
    FROM matches WHERE id=${matchId}`;
  return (rows[0] as MatchOutcome | undefined) ?? null;
}

export async function pendingDisconnect(matchId: string): Promise<DisconnectNotice | null> {
  const rows = await getSql()`SELECT mp.user_id AS "userId",u.name,mp.team,
      COALESCE(mp.disconnect_started_at,mp.last_heartbeat_at)+INTERVAL '10 seconds' AS "expiresAt",
      GREATEST(0,CEIL(EXTRACT(EPOCH FROM (
        COALESCE(mp.disconnect_started_at,mp.last_heartbeat_at)+INTERVAL '10 seconds'-NOW()
      )))::int AS "secondsRemaining"
    FROM match_players mp JOIN users u ON u.id=mp.user_id JOIN matches m ON m.id=mp.match_id
    WHERE mp.match_id=${matchId} AND m.status='active' AND NOW()<m.ends_at
      AND mp.presence_confirmed_at IS NOT NULL
      AND (mp.disconnect_started_at IS NOT NULL OR mp.last_heartbeat_at<NOW()-INTERVAL '4 seconds')
    ORDER BY COALESCE(mp.disconnect_started_at,mp.last_heartbeat_at),mp.joined_at
    LIMIT 1`;
  return (rows[0] as DisconnectNotice | undefined) ?? null;
}

export async function finalizeForfeit(
  matchId: string,
  losingTeam: MatchTeam,
  reason: MatchEndReason,
  forfeitedBy: string,
) {
  const winner: MatchTeam = losingTeam === "blue" ? "red" : "blue";
  const rows = await getSql()`WITH claimed AS (
      UPDATE matches SET status='finalizing',winning_team=${winner}::match_team,ended_at=NOW(),
        end_reason=${reason},forfeited_by=${forfeitedBy},forfeiting_team=${losingTeam}::match_team
      WHERE id=${matchId} AND status='active' AND NOW()<ends_at AND (
        ${reason}='forfeit' OR EXISTS (
          SELECT 1 FROM match_players stale WHERE stale.match_id=matches.id
            AND stale.user_id=${forfeitedBy} AND stale.team=${losingTeam}::match_team
            AND stale.presence_confirmed_at IS NOT NULL
            AND COALESCE(stale.disconnect_started_at,stale.last_heartbeat_at)+INTERVAL '10 seconds'<=NOW()
        )
      )
      RETURNING id,winning_team
    ), team_averages AS (
      SELECT mp.team,AVG(u.elo)::numeric AS average_elo
      FROM match_players mp JOIN users u ON u.id=mp.user_id JOIN claimed c ON c.id=mp.match_id
      GROUP BY mp.team
    ), ratings AS (
      SELECT mp.user_id,mp.match_id,mp.team,u.elo AS before,opponent.average_elo,
        CASE WHEN mp.team=c.winning_team THEN 1.0 ELSE 0.0 END AS score
      FROM match_players mp JOIN users u ON u.id=mp.user_id JOIN claimed c ON c.id=mp.match_id
      JOIN team_averages opponent ON opponent.team<>mp.team
    ), inserted AS (
      INSERT INTO elo_transactions (id,user_id,match_id,source_key,before,delta,after,reason)
      SELECT gen_random_uuid()::text,user_id,match_id,'forfeit:'||match_id,before,
        ROUND(32*(score-(1.0/(1.0+POWER(10,(average_elo-before)/400.0)))))::int,
        before+ROUND(32*(score-(1.0/(1.0+POWER(10,(average_elo-before)/400.0)))))::int,
        ${reason}
      FROM ratings ON CONFLICT (user_id,source_key) DO NOTHING
      RETURNING user_id,match_id,after
    ), updated_users AS (
      UPDATE users u SET elo=i.after,matches_played=u.matches_played+1,updated_at=NOW()
      FROM inserted i WHERE u.id=i.user_id RETURNING u.id
    ), updated_players AS (
      UPDATE match_players mp SET post_elo=i.after,finished_at=NOW()
      FROM inserted i WHERE mp.match_id=i.match_id AND mp.user_id=i.user_id RETURNING mp.user_id
    ), completed AS (
      UPDATE matches m SET status='completed',players_counted=TRUE
      FROM claimed c WHERE m.id=c.id RETURNING m.id,m.winning_team AS "winningTeam",
        m.end_reason AS "endReason",m.forfeited_by AS "forfeitedBy",
        m.forfeiting_team AS "forfeitingTeam",m.ended_at AS "endedAt"
    ) SELECT * FROM completed`;

  const completed = rows[0] as Omit<MatchOutcome, "status" | "remainingSeconds"> | undefined;
  if (!completed) return null;

  const players = await getSql()`SELECT user_id FROM match_players WHERE match_id=${matchId}`;
  await Promise.allSettled(
    players.map(player =>
      addChallengeProgress(String(player.user_id), "play_matches", 1),
    ),
  );
  return { status: "completed", remainingSeconds: 0, ...completed } satisfies MatchOutcome;
}
