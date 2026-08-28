import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import {
  RECORDING_RETENTION_DAYS,
  RECORDING_SEGMENT_MS,
  validRecordingMimeType,
} from "@/app/lib/recording-policy";
import {
  isSameOriginMutation,
  PRIVATE_RECORDING_HEADERS,
  purgeExpiredRecordings,
} from "@/app/lib/recordings";
import { getSql } from "@/db";

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Invalid request origin." },
      { status: 403, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const body = await request.json().catch(() => null);
  const matchId = typeof body?.matchId === "string" ? body.matchId : "";
  const mimeType = validRecordingMimeType(body?.mimeType)
    ? body.mimeType.trim()
    : null;
  if (!matchId || !mimeType) {
    return NextResponse.json(
      { error: "Invalid recording session." },
      { status: 400, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  await purgeExpiredRecordings(10).catch((error) =>
    console.error("Recording cleanup failed", error),
  );

  const eligible = await getSql()`
    SELECT m.id,m.ends_at AS "endsAt"
    FROM matches m
    JOIN match_players mp ON mp.match_id=m.id AND mp.user_id=${user.id}
    JOIN match_recording_consents c ON c.match_id=m.id AND c.user_id=mp.user_id
    WHERE m.id=${matchId}
      AND m.started_at<=NOW()
      AND COALESCE(m.ended_at,m.ends_at)+INTERVAL '5 minutes'>NOW()
    LIMIT 1
  `;
  if (!eligible.length) {
    return NextResponse.json(
      { error: "Recording is not authorized for this match." },
      { status: 403, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const recordingId = crypto.randomUUID();
  const rows = await getSql()`
    INSERT INTO match_recordings
      (id,match_id,user_id,participant_name,participant_email,mime_type,expires_at)
    VALUES (
      ${recordingId},${matchId},${user.id},${user.name},${user.email},${mimeType},
      (SELECT ends_at FROM matches WHERE id=${matchId})+
        (${RECORDING_RETENTION_DAYS}||' days')::interval
    )
    ON CONFLICT (match_id,user_id) DO UPDATE SET
      status='recording',mime_type=EXCLUDED.mime_type,updated_at=NOW()
    RETURNING id,mime_type AS "mimeType",expires_at AS "expiresAt"
  `;
  const recording = rows[0];
  const segmentRows = await getSql()`
    SELECT COALESCE(MAX(segment_index)+1,0)::int AS "nextIndex"
    FROM recording_segments WHERE recording_id=${recording.id}
  `;
  return NextResponse.json(
    {
      recordingId: recording.id,
      mimeType: recording.mimeType,
      expiresAt: recording.expiresAt,
      nextIndex: Number(segmentRows[0]?.nextIndex ?? 0),
      segmentDurationMs: RECORDING_SEGMENT_MS,
    },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}

export async function PATCH(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Invalid request origin." },
      { status: 403, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const body = await request.json().catch(() => null);
  const recordingId = typeof body?.recordingId === "string" ? body.recordingId : "";
  if (!recordingId) {
    return NextResponse.json(
      { error: "Invalid recording session." },
      { status: 400, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const rows = await getSql()`
    UPDATE match_recordings r SET
      status='complete',completed_at=COALESCE(completed_at,NOW()),
      expires_at=(
        SELECT COALESCE(m.ended_at,LEAST(m.ends_at,NOW()),NOW())+
          (${RECORDING_RETENTION_DAYS}||' days')::interval
        FROM matches m WHERE m.id=r.match_id
      ),
      updated_at=NOW()
    WHERE r.id=${recordingId} AND r.user_id=${user.id}
    RETURNING id,expires_at AS "expiresAt"
  `;
  if (!rows.length) {
    return NextResponse.json(
      { error: "Recording not found." },
      { status: 404, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  return NextResponse.json(
    { ok: true, expiresAt: rows[0].expiresAt },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
