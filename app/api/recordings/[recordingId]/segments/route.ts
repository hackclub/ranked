import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import {
  RECORDING_MAX_SEGMENT_BYTES,
  RECORDING_SEGMENT_MS,
  recordingExtension,
  validRecordingMimeType,
} from "@/app/lib/recording-policy";
import {
  isSameOriginMutation,
  PRIVATE_RECORDING_HEADERS,
} from "@/app/lib/recordings";
import { putRecordingObject } from "@/app/lib/r2";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import { getSql } from "@/db";

type Context = { params: Promise<{ recordingId: string }> };

function validSegmentIndex(value: unknown) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

// The only way a clip reaches storage: through this authenticated route,
// which reads the body itself and enforces RECORDING_MAX_SEGMENT_BYTES before
// anything is written. There is deliberately no presigned-URL upload path —
// a browser holding a direct upload URL could send a file of any size.
export async function PUT(request: NextRequest, context: Context) {
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

  // A working client sends one clip every ten seconds, plus the odd retry.
  // Each one is up to 12 MB of storage, so the ceiling sits just above that.
  if (await rateLimited(`recording-segment:${user.id}`, 30, 60)) {
    return tooManyRequests(undefined, PRIVATE_RECORDING_HEADERS);
  }
  const { recordingId } = await context.params;
  const segmentIndex = validSegmentIndex(
    request.nextUrl.searchParams.get("segmentIndex"),
  );
  const requestedDuration = Number(
    request.nextUrl.searchParams.get("durationMs"),
  );
  const durationMs = Number.isFinite(requestedDuration)
    ? Math.max(0, Math.min(RECORDING_SEGMENT_MS * 2, Math.round(requestedDuration)))
    : null;
  const mimeTypeHeader = request.headers.get("content-type") ?? "";
  const mimeType = validRecordingMimeType(mimeTypeHeader)
    ? mimeTypeHeader.trim()
    : null;
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    segmentIndex === null ||
    durationMs === null ||
    !mimeType ||
    (Number.isFinite(declaredLength) && declaredLength > RECORDING_MAX_SEGMENT_BYTES)
  ) {
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
      AND r.status<>'deleting'
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
      { ok: true, alreadyUploaded: true },
      { headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > RECORDING_MAX_SEGMENT_BYTES) {
    return NextResponse.json(
      { error: "Recording segment exceeded the secure upload limit." },
      { status: 413, headers: PRIVATE_RECORDING_HEADERS },
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

  try {
    await putRecordingObject(objectKey, mimeType, bytes);
  } catch (error) {
    console.error("Private recording upload failed", error);
    return NextResponse.json(
      { error: "Private recording storage rejected the upload." },
      { status: 502, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  await getSql()`
    UPDATE recording_segments SET
      status='uploaded',size_bytes=${bytes.byteLength},duration_ms=${durationMs},uploaded_at=NOW()
    WHERE id=${segmentId}
  `;
  return NextResponse.json(
    { ok: true, sizeBytes: bytes.byteLength },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
