import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { finalizeForfeit, matchOutcome, pendingDisconnect } from "@/app/lib/match-lifecycle";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const rows = await getSql()`
    WITH elapsed AS (
      SELECT mp.match_id,mp.user_id,LEAST(90,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-COALESCE(mp.last_heartbeat_at,NOW())))::int)) AS delta
      FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.match_id=${matchId} AND mp.user_id=${user.id} AND m.status='active'
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
  `;
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
  });
}
