import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch, generateMatchTheme } from "@/app/lib/match-lifecycle";
import { canUseTestLobby } from "@/app/lib/test-lobby";
import { getSql } from "@/db";

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const existing = await activeMatch(user.id);
  if (existing) return NextResponse.json({ status: "matched", match: existing });
  if (!user.hackatimeConnected) {
    return NextResponse.json(
      { error: "Connect Hackatime before starting a test match.", code: "hackatime_required" },
      { status: 403 },
    );
  }
  if (!canUseTestLobby(user.email)) return NextResponse.json({ error: "Not available for your account." }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const duration = [10, 30, 60].includes(Number(body.durationMinutes)) ? Number(body.durationMinutes) : 10;
  const mode = body.mode === "duo" ? "duo" : "solo";
  const matchId = crypto.randomUUID();
  const theme = generateMatchTheme();
  await getSql()`DELETE FROM matchmaking_queue WHERE user_id = ${user.id}`;
  await getSql()`INSERT INTO matches (id, mode, is_test, duration_minutes, theme, ends_at)
    VALUES (${matchId}, ${mode}::match_mode, TRUE, ${duration}, ${theme}, NOW() + (${duration} || ' minutes')::interval)`;
  await getSql()`INSERT INTO match_players (match_id, user_id, team, slot, pre_elo, last_heartbeat_at)
    VALUES (${matchId}, ${user.id}, 'blue'::match_team, 0, ${user.elo}, NOW())`;

  const match = await activeMatch(user.id);
  return NextResponse.json(match ? { status: "matched", match } : { status: "queued" });
}
