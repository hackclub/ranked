import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch } from "@/app/lib/match-lifecycle";
import { isAdmin } from "@/app/lib/admin";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const rows = await getSql()`SELECT m.status
    FROM match_players mp JOIN matches m ON m.id=mp.match_id
    WHERE mp.match_id=${matchId} AND mp.user_id=${user.id}`;
  const player = rows[0] as { status: string } | undefined;
  if (!player) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
  if (!isAdmin(user.email)) {
    return NextResponse.json({ error: "Not available for this match." }, { status: 403 });
  }
  if (player.status !== "active") {
    return NextResponse.json({ error: "This match has already ended.", match: await activeMatch(user.id) }, { status: 409 });
  }
  await getSql()`UPDATE matches SET ends_at=NOW() WHERE id=${matchId} AND status='active'`;
  return NextResponse.json({ match: await activeMatch(user.id) });
}
