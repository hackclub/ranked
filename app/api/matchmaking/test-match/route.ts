import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch, MATCH_THEMES } from "@/app/lib/match-lifecycle";
import { canUseTestLobby } from "@/app/lib/test-lobby";
import { getSql } from "@/db";

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canUseTestLobby(user.email)) return NextResponse.json({ error: "Not available for your account." }, { status: 403 });
  const existing = await activeMatch(user.id);
  if (existing) return NextResponse.json({ status: "matched", match: existing });

  const matchId = crypto.randomUUID();
  const theme = MATCH_THEMES[Math.floor(Math.random() * MATCH_THEMES.length)];
  const duration = 10;
  await getSql()`DELETE FROM matchmaking_queue WHERE user_id = ${user.id}`;
  await getSql()`INSERT INTO matches (id, mode, duration_minutes, theme, ends_at)
    VALUES (${matchId}, 'solo'::match_mode, ${duration}, ${theme}, NOW() + (${duration} || ' minutes')::interval)`;
  await getSql()`INSERT INTO match_players (match_id, user_id, team, slot, pre_elo, last_heartbeat_at)
    VALUES (${matchId}, ${user.id}, 'blue'::match_team, 0, ${user.elo}, NOW())`;

  const match = await activeMatch(user.id);
  return NextResponse.json(match ? { status: "matched", match } : { status: "queued" });
}
