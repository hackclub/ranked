import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import {
  RECORDING_MAX_SEGMENT_BYTES,
  RECORDING_SEGMENT_MS,
  RECORDING_UPLOAD_URL_TTL_SECONDS,
  recordingExtension,
  validRecordingMimeType,
} from "@/app/lib/recording-policy";
import {
  isSameOriginMutation,
  PRIVATE_RECORDING_HEADERS,
} from "@/app/lib/recordings";
import {
  deleteRecordingObjects,
  headRecordingObject,
  signedRecordingUploadUrl,
} from "@/app/lib/r2";
import { getSql } from "@/db";

type Context = { params: Promise<{ recordingId: string }> };

function validSegmentIndex(value: unknown) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export async function POST(request: NextRequest, context: Context) {
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
  const { recordingId } = await context.params;
  const body = await request.json().catch(() => null);
  const segmentIndex = validSegmentIndex(body?.segmentIndex);
  const mimeType = validRecordingMimeType(body?.mimeType)
    ? body.mimeType.trim()
    : null;
  if (segmentIndex === null || !mimeType) {
    return NextResponse.json(
      { error: "Invalid recording segment." },
      { status: 400, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const recordings = await getSql()`
    SELECT r.id,r.mime_type AS "mimeType",m.duration_minutes AS "durationMinutes"
    FROM match_recordings r
    JOIN matches m ON m.id=r.match_id
    JOIN match_recording_consents c ON c.match_id=r.match_id AND c.user_id=r.user_id
    WHERE r.id=${recordingId} AND r.user_id=${user.id} AND r.expires_at>NOW()
      AND COALESCE(m.ended_at,m.ends_at)+INTERVAL '5 minutes'>NOW()
    LIMIT 1
  `;
  const recording = recordings[0];
  if (!recording) {
    return NextResponse.json(
      { error: "Recording not found." },
      { status: 404, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  if (recording.mimeType !== mimeType) {
    return NextResponse.json(
      { error: "Recording format changed unexpectedly." },
      { status: 409, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const maxSegments = Math.ceil(
    (Number(recording.durationMinutes) * 60_000) / RECORDING_SEGMENT_MS,
  ) + 60;
  if (segmentIndex >= maxSegments) {
    return NextResponse.json(
      { error: "Recording segment is outside the match window." },
      { status: 400, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const existing = await getSql()`
    SELECT id,object_key AS "objectKey",status
    FROM recording_segments
    WHERE recording_id=${recordingId} AND segment_index=${segmentIndex}
    LIMIT 1
  `;
  if (existing[0]?.status === "uploaded") {
    return NextResponse.json(
      { alreadyUploaded: true },
      { headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const segmentId = existing[0]?.id ?? crypto.randomUUID();
  const objectKey =
    existing[0]?.objectKey ??
    `recordings/${recordingId}/${String(segmentIndex).padStart(5, "0")}-${segmentId}.${recordingExtension(mimeType)}`;
  if (!existing.length) {
    await getSql()`
      INSERT INTO recording_segments
        (id,recording_id,segment_index,object_key,mime_type)
      VALUES (${segmentId},${recordingId},${segmentIndex},${objectKey},${mimeType})
    `;
  }
  const uploadUrl = await signedRecordingUploadUrl(objectKey, mimeType);
  return NextResponse.json(
    {
      uploadUrl,
      segmentIndex,
      expiresIn: RECORDING_UPLOAD_URL_TTL_SECONDS,
      requiredHeaders: {
        "Content-Type": mimeType,
        "Cache-Control": "private, no-store",
      },
    },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}

export async function PATCH(request: NextRequest, context: Context) {
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
  const { recordingId } = await context.params;
  const body = await request.json().catch(() => null);
  const segmentIndex = validSegmentIndex(body?.segmentIndex);
  const requestedDuration = Number(body?.durationMs);
  const durationMs = Number.isFinite(requestedDuration)
    ? Math.max(0, Math.min(RECORDING_SEGMENT_MS * 2, Math.round(requestedDuration)))
    : null;
  if (segmentIndex === null || durationMs === null) {
    return NextResponse.json(
      { error: "Invalid recording segment." },
      { status: 400, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const rows = await getSql()`
    SELECT s.id,s.object_key AS "objectKey",s.mime_type AS "mimeType",s.status
    FROM recording_segments s
    JOIN match_recordings r ON r.id=s.recording_id
    WHERE s.recording_id=${recordingId} AND s.segment_index=${segmentIndex}
      AND r.user_id=${user.id} AND r.expires_at>NOW()
    LIMIT 1
  `;
  const segment = rows[0];
  if (!segment) {
    return NextResponse.json(
      { error: "Recording segment not found." },
      { status: 404, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  if (segment.status === "uploaded") {
    return NextResponse.json(
      { ok: true, alreadyUploaded: true },
      { headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const object = await headRecordingObject(String(segment.objectKey));
  const sizeBytes = Number(object.ContentLength ?? 0);
  if (
    sizeBytes <= 0 ||
    sizeBytes > RECORDING_MAX_SEGMENT_BYTES ||
    object.ContentType !== segment.mimeType
  ) {
    await deleteRecordingObjects([String(segment.objectKey)]);
    await getSql()`DELETE FROM recording_segments WHERE id=${segment.id}`;
    return NextResponse.json(
      { error: "Uploaded recording segment failed validation." },
      { status: 400, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  await getSql()`
    UPDATE recording_segments SET
      status='uploaded',size_bytes=${sizeBytes},duration_ms=${durationMs},uploaded_at=NOW()
    WHERE id=${segment.id}
  `;
  return NextResponse.json(
    { ok: true, sizeBytes },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
