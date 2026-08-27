import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/app/lib/audit";
import { recordingReviewer } from "@/app/lib/recording-reviewer";
import {
  isSameOriginMutation,
  PRIVATE_RECORDING_HEADERS,
} from "@/app/lib/recordings";
import { deleteRecordingObjects } from "@/app/lib/r2";
import { getSql } from "@/db";

type Context = { params: Promise<{ recordingId: string }> };

function hiddenResponse() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: PRIVATE_RECORDING_HEADERS },
  );
}

export async function DELETE(request: NextRequest, context: Context) {
  const reviewer = await recordingReviewer(request);
  if (!reviewer) return hiddenResponse();
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Invalid request origin." },
      { status: 403, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  const { recordingId } = await context.params;
  const rows = await getSql()`
    UPDATE match_recordings r SET status='deleting',updated_at=NOW()
    WHERE r.id=${recordingId}
    RETURNING r.id,r.match_id AS "matchId",
      r.participant_name AS "participantName",
      r.participant_email AS "participantEmail"
  `;
  const recording = rows[0];
  if (!recording) return hiddenResponse();

  const objectRows = await getSql()`
    SELECT object_key AS "objectKey"
    FROM recording_segments
    WHERE recording_id=${recordingId}
    ORDER BY segment_index
  `;
  const objectKeys = objectRows.map((row) => String(row.objectKey));
  try {
    await deleteRecordingObjects(objectKeys);
  } catch (error) {
    console.error("Reviewer recording deletion failed", error);
    await logAudit({
      actor: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
      action: "recording.delete_failed",
      summary: `${reviewer.name} attempted to delete ${recording.participantName}'s match recording`,
      targetType: "recording",
      targetId: recordingId,
      metadata: {
        matchId: recording.matchId,
        participantEmail: recording.participantEmail,
        objectCount: objectKeys.length,
      },
    });
    return NextResponse.json(
      { error: "The private recording could not be fully removed. Try again." },
      { status: 502, headers: PRIVATE_RECORDING_HEADERS },
    );
  }

  await getSql()`
    DELETE FROM match_recordings
    WHERE id=${recordingId} AND status='deleting'
  `;
  await logAudit({
    actor: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
    action: "recording.deleted",
    summary: `${reviewer.name} permanently deleted ${recording.participantName}'s match recording`,
    targetType: "recording",
    targetId: recordingId,
    metadata: {
      matchId: recording.matchId,
      participantEmail: recording.participantEmail,
      objectsDeleted: objectKeys.length,
    },
  });
  return NextResponse.json(
    { ok: true, recordingId, objectsDeleted: objectKeys.length },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
