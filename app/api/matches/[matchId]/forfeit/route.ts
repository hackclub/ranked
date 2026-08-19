import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { finalizeForfeit, matchOutcome, type MatchTeam } from "@/app/lib/match-lifecycle";
import { canUseTestLobby } from "@/app/lib/test-lobby";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const rows = await getSql()`SELECT mp.team,m.status,m.is_test AS "isTest",m.ends_at>NOW() AS "beforeEnd"
    FROM match_players mp JOIN matches m ON m.id=mp.match_id
    WHERE mp.match_id=${matchId} AND mp.user_id=${user.id}`;
  const player = rows[0] as { team: MatchTeam; status: string; isTest: boolean; beforeEnd: boolean } | undefined;
  if (!player) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
  const isAdminLobby = player.isTest && canUseTestLobby(user.email);
  if (player.status !== "active" || (!player.beforeEnd && !isAdminLobby)) {
    return NextResponse.json({ error: "This match has already ended.", match: await matchOutcome(matchId) }, { status: 409 });
  }
  const outcome = await finalizeForfeit(matchId, player.team, "forfeit", user.id, isAdminLobby);
  if (!outcome) {
    return NextResponse.json({ error: "This match has already closed.", match: await matchOutcome(matchId) }, { status: 409 });
  }
  return NextResponse.json({ match: outcome });
}
