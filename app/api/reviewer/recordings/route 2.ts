import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/app/lib/audit";
import { recordingReviewer } from "@/app/lib/recording-reviewer";
import {
  PRIVATE_RECORDING_HEADERS,
  purgeExpiredRecordings,
} from "@/app/lib/recordings";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const reviewer = await recordingReviewer(request);
  if (!reviewer) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  await purgeExpiredRecordings(50).catch((error) =>
    console.error("Recording cleanup failed", error),
  );
  const rows = await getSql()`
    SELECT
      r.id AS "recordingId",r.match_id AS "matchId",
      r.participant_name AS "participantName",
      r.participant_email AS "participantEmail",
      r.status,r.mime_type AS "mimeType",r.started_at AS "startedAt",
      r.completed_at AS "completedAt",r.expires_at AS "expiresAt",
      m.theme,m.mode,m.duration_minutes AS "durationMinutes",
      m.started_at AS "matchStartedAt",m.ended_at AS "matchEndedAt",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name',u.name,'email',u.email,'team',mp.team,'slot',mp.slot
        ) ORDER BY mp.slot)
        FROM match_players mp JOIN users u ON u.id=mp.user_id
        WHERE mp.match_id=r.match_id
      ),'[]'::jsonb) AS participants,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',s.id,'index',s.segment_index,'durationMs',s.duration_ms,
          'sizeBytes',s.size_bytes
        ) ORDER BY s.segment_index)
        FROM recording_segments s
        WHERE s.recording_id=r.id AND s.status='uploaded'
      ),'[]'::jsonb) AS segments
    FROM match_recordings r
    JOIN matches m ON m.id=r.match_id
    WHERE r.expires_at>NOW()
    ORDER BY m.started_at DESC,r.participant_name
    LIMIT 500
  `;
  await logAudit({
    actor: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
    action: "recording.review_list",
    summary: `${reviewer.name} opened the private recording review dashboard`,
    targetType: "recording",
    metadata: { visibleRecordings: rows.length },
  });
  return NextResponse.json(
    { recordings: rows },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
