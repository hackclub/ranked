import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/app/lib/audit";
import { currentUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { getVoteGate } from "@/app/lib/vote-gate";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [rows, voteGate] = await Promise.all([
    getSql()`WITH canonical AS (
        SELECT DISTINCT ON (match_id,team) match_id,team,pages_url,repository_url,description FROM publications ORDER BY match_id,team,random()
      ) SELECT m.id, m.theme, m.mode, m.duration_minutes AS "durationMinutes",
        json_object_agg(p.team, json_build_object('pagesUrl',p.pages_url,'repositoryUrl',p.repository_url,'description',p.description)) AS sites
      FROM matches m JOIN canonical p ON p.match_id=m.id
      WHERE m.status='voting' AND NOT EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id=m.id AND mp.user_id=${user.id})
        AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.match_id=m.id AND v.voter_id=${user.id})
      GROUP BY m.id HAVING COUNT(*)=2 ORDER BY m.voting_ends_at NULLS LAST, m.created_at LIMIT 1`,
    getVoteGate(user.id, user.matchesPlayed),
  ]);
  return NextResponse.json({ match: rows[0] ?? null, voteGate });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId, choice } = await request.json();
  if (!matchId || !["blue", "red"].includes(choice)) return NextResponse.json({ error: "Invalid vote" }, { status: 400 });
  const eligible = await getSql()`SELECT id FROM matches m WHERE id=${matchId} AND status='voting'
    AND NOT EXISTS (SELECT 1 FROM match_players WHERE match_id=m.id AND user_id=${user.id})
    AND (SELECT COUNT(DISTINCT team)::int FROM publications WHERE match_id=m.id)=2`;
  if (!eligible.length) return NextResponse.json({ error: "You cannot vote on this match." }, { status: 403 });
  const inserted = await getSql()`INSERT INTO votes (id, match_id, voter_id, choice) VALUES (${crypto.randomUUID()},${matchId},${user.id},${choice}::match_team)
    ON CONFLICT (match_id,voter_id) DO NOTHING RETURNING id`;
  if (inserted.length) {
    await addChallengeProgress(user.id, "cast_votes", 1);
    await logAudit({
      actor: { id: user.id, name: user.name, email: user.email },
      action: "vote.cast",
      summary: `${user.name} voted for the ${choice} team's build`,
      targetType: "match",
      targetId: matchId,
      metadata: { choice },
    });
  }
  const threshold = Math.max(1, Number(process.env.VOTES_TO_FINALIZE ?? 3));
  const result = await getSql()`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE choice='blue')::int AS blue, COUNT(*) FILTER (WHERE choice='red')::int AS red FROM votes WHERE match_id=${matchId}`;
  const tally = result[0] as { total: number; blue: number; red: number };
  if (Number(tally.total) >= threshold) {
    const winner = Number(tally.blue) >= Number(tally.red) ? "blue" : "red";
    const claimed = await getSql()`UPDATE matches SET status='finalizing', winning_team=${winner}::match_team
      WHERE id=${matchId} AND status='voting' RETURNING id, theme, mode`;
    if (claimed.length) {
      await getSql().transaction([
        getSql()`WITH team_averages AS (
            SELECT mp.team,AVG(u.elo)::numeric AS average_elo FROM match_players mp JOIN users u ON u.id=mp.user_id
            WHERE mp.match_id=${matchId} GROUP BY mp.team
          ), ratings AS (
            SELECT mp.user_id,mp.match_id,mp.team,u.elo AS before,
              opponent.average_elo,
              CASE WHEN mp.team=${winner}::match_team THEN 1.0 ELSE 0.0 END AS score
            FROM match_players mp JOIN users u ON u.id=mp.user_id
            JOIN team_averages opponent ON opponent.team<>mp.team WHERE mp.match_id=${matchId}
          ), scored AS (
            SELECT *,ROUND(32*(score-(1.0/(1.0+POWER(10,(average_elo-before)/400.0)))))::int AS delta FROM ratings
          ) INSERT INTO elo_transactions (id,user_id,match_id,source_key,before,delta,after,reason)
          SELECT gen_random_uuid()::text,user_id,match_id,'match:'||match_id,before,delta,before+delta,'community_vote' FROM scored
          ON CONFLICT (user_id,source_key) DO NOTHING`,
        getSql()`UPDATE users u SET elo=e.after, matches_played=matches_played+1, updated_at=NOW()
          FROM elo_transactions e WHERE e.match_id=${matchId} AND e.user_id=u.id`,
        getSql()`UPDATE match_players mp SET post_elo=e.after FROM elo_transactions e
          WHERE e.match_id=${matchId} AND e.match_id=mp.match_id AND e.user_id=mp.user_id`,
        getSql()`UPDATE matches SET status='completed', players_counted=TRUE WHERE id=${matchId}`,
      ]);
      const players = await getSql()`SELECT user_id,team FROM match_players WHERE match_id=${matchId}`;
      await Promise.all(players.flatMap(row => [
        addChallengeProgress(String(row.user_id), "play_matches", 1),
        ...(row.team === winner ? [addChallengeProgress(String(row.user_id), "win_matches", 1)] : []),
        ...(claimed[0].mode === "duo" ? [addChallengeProgress(String(row.user_id), "duo_match", 1)] : []),
      ]));

      const roster = await getSql()`SELECT u.name, mp.team FROM match_players mp JOIN users u ON u.id=mp.user_id WHERE mp.match_id=${matchId}`;
      const winners = roster.filter((row) => row.team === winner).map((row) => row.name).join(" & ");
      const losers = roster.filter((row) => row.team !== winner).map((row) => row.name).join(" & ");
      await logAudit({
        actor: null,
        action: "match.decided",
        summary: `Community vote decided a ${claimed[0].mode} match ("${claimed[0].theme}"): ${winners || "the " + winner + " team"} beat ${losers || "the other team"} (blue ${tally.blue}–red ${tally.red})`,
        targetType: "match",
        targetId: matchId,
        metadata: { winner, tally },
      });
    }
  }
  return NextResponse.json({ ok: true, tally });
}
