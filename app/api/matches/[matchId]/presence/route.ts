import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const rows = await getSql()`UPDATE match_players mp SET disconnect_started_at=COALESCE(disconnect_started_at,NOW())
    FROM matches m WHERE mp.match_id=${matchId} AND mp.user_id=${user.id} AND m.id=mp.match_id
      AND m.status='active' AND NOW()<m.ends_at RETURNING mp.user_id`;
  return NextResponse.json({ ok: rows.length > 0 });
}
