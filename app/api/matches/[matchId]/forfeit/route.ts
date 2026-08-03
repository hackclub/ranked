import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { finalizeForfeit, matchOutcome, type MatchTeam } from "@/app/lib/match-lifecycle";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const rows = await getSql()`SELECT mp.team,m.status,m.ends_at>NOW() AS "beforeEnd"
    FROM match_players mp JOIN matches m ON m.id=mp.match_id
    WHERE mp.match_id=${matchId} AND mp.user_id=${user.id}`;
  const player = rows[0] as { team: MatchTeam; status: string; beforeEnd: boolean } | undefined;
  if (!player) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
  if (player.status !== "active" || !player.beforeEnd) {
    return NextResponse.json({ error: "This match has already ended.", match: await matchOutcome(matchId) }, { status: 409 });
  }
  const outcome = await finalizeForfeit(matchId, player.team, "forfeit", user.id);
  if (!outcome) {
    return NextResponse.json({ error: "This match has already closed.", match: await matchOutcome(matchId) }, { status: 409 });
  }
  return NextResponse.json({ match: outcome });
}
