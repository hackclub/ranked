import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { finalizeForfeit, matchOutcome, pendingDisconnect } from "@/app/lib/match-lifecycle";
import { flagMissingRecording, recordingHealth } from "@/app/lib/recordings";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  // Coding time (and the H-Bucks it earns) only accrues inside the match's own
  // timer, and only until this player has published. A match stays 'active'
  // until every player publishes, so without the LEAST(NOW(),ends_at) clamp
  // and the finished_at check a player whose opponent never publishes could
  // keep this endpoint ticking — and paying out — indefinitely.
  //
  // It also only accrues while the player's team is actually changing its
  // code. match_snapshots.updated_at moves only when a team's build changes
  // (see the snapshot route), so a tab left open — or a script that does
  // nothing but call this endpoint — keeps the player connected but earns
  // nothing. The heartbeat clock still advances either way, so idle time is
  // dropped rather than banked for the next edit.
  const [rows, recording] = await Promise.all([getSql()`
    WITH elapsed AS (
      SELECT mp.match_id,mp.user_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM match_snapshots s
          WHERE s.match_id=mp.match_id AND s.team=mp.team
            AND s.updated_at>NOW()-INTERVAL '5 minutes'
        ) THEN LEAST(90,GREATEST(0,EXTRACT(EPOCH FROM (LEAST(NOW(),m.ends_at)-COALESCE(mp.last_heartbeat_at,NOW())))::int))
        ELSE 0 END AS delta
      FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.match_id=${matchId} AND mp.user_id=${user.id} AND m.status='active' AND mp.finished_at IS NULL
    ), tick AS (
      UPDATE match_players mp SET
        coding_seconds = mp.coding_seconds + elapsed.delta,
        last_heartbeat_at = NOW(),
        presence_confirmed_at = COALESCE(mp.presence_confirmed_at,NOW()),
        disconnect_started_at = NULL
      FROM elapsed WHERE mp.match_id=elapsed.match_id AND mp.user_id=elapsed.user_id RETURNING elapsed.delta
    ), credit AS (
      UPDATE users SET coding_seconds = coding_seconds + (SELECT delta FROM tick),
        h_bucks = h_bucks + ((coding_seconds + (SELECT delta FROM tick))/3600 - coding_seconds/3600)*10, updated_at=NOW()
      WHERE id=${user.id} AND EXISTS (SELECT 1 FROM tick) RETURNING coding_seconds, h_bucks
    ) SELECT (SELECT delta FROM tick)::int AS delta, coding_seconds AS "codingSeconds", h_bucks AS "hBucks" FROM credit
  `, recordingHealth(matchId, user.id)]);
  // Everything below reports on the match itself — its outcome, and who in it
  // is disconnecting — and can finalize a forfeit, so it is for players in the
  // match only. (The tick above already does nothing for anyone else.)
  if (!recording.participant) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!recording.ok) await flagMissingRecording(matchId, user);
  const delta = Number(rows[0]?.delta ?? 0);
  if (delta) await addChallengeProgress(user.id, "code_seconds", delta);

  let disconnect = await pendingDisconnect(matchId);
  if (disconnect && Number(disconnect.secondsRemaining) <= 0) {
    await finalizeForfeit(matchId, disconnect.team, "disconnect", disconnect.userId);
    disconnect = null;
  }
  return NextResponse.json({
    ok: true,
    ...(rows[0] ?? { delta: 0 }),
    match: await matchOutcome(matchId),
    disconnect,
    // false tells the client its safety recording isn't reaching storage, so
    // it must stop sending its camera and microphone to the call until it is.
    recordingOk: recording.ok,
  });
}
