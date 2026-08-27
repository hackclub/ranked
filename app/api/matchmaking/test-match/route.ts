import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch, generateMatchTheme } from "@/app/lib/match-lifecycle";
import { isAdmin } from "@/app/lib/admin";
import { logAudit } from "@/app/lib/audit";
import { RECORDING_POLICY_VERSION } from "@/app/lib/recording-policy";
import { recordingStorageConfigured } from "@/app/lib/r2";
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
  if (!isAdmin(user.email)) return NextResponse.json({ error: "Not available for your account." }, { status: 403 });
  if (!recordingStorageConfigured()) {
    return NextResponse.json(
      { error: "Private match recording storage is not configured yet.", code: "recording_unavailable" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}));
  if (body.recordingConsent !== true) {
    return NextResponse.json(
      { error: "Recording consent is required.", code: "recording_consent_required" },
      { status: 403 },
    );
  }
  const duration = [10, 30, 60].includes(Number(body.durationMinutes)) ? Number(body.durationMinutes) : 10;
  const mode = body.mode === "duo" ? "duo" : "solo";
  const matchId = crypto.randomUUID();
  const theme = generateMatchTheme();
  await getSql()`DELETE FROM matchmaking_queue WHERE user_id = ${user.id}`;
  await getSql()`INSERT INTO matches (id, mode, is_test, duration_minutes, theme, ends_at)
    VALUES (${matchId}, ${mode}::match_mode, TRUE, ${duration}, ${theme}, NOW() + (${duration} || ' minutes')::interval)`;
  await getSql()`INSERT INTO match_players (match_id, user_id, team, slot, pre_elo, last_heartbeat_at)
    VALUES (${matchId}, ${user.id}, 'blue'::match_team, 0, ${user.elo}, NOW())`;
  await getSql()`INSERT INTO match_recording_consents (match_id,user_id,policy_version,consented_at)
    VALUES (${matchId},${user.id},${RECORDING_POLICY_VERSION},NOW())`;
  await logAudit({
    actor: { id: user.id, name: user.name, email: user.email },
    action: "admin.test_lobby.entered",
    summary: `${user.name} entered an empty test lobby (${mode}, ${duration} min)`,
    targetType: "match",
    targetId: matchId,
  });

  const match = await activeMatch(user.id);
  return NextResponse.json(match ? { status: "matched", match } : { status: "queued" });
}
