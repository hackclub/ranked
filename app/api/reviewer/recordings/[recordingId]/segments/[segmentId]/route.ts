import { NextRequest } from "next/server";
import { logAudit } from "@/app/lib/audit";
import { recordingReviewer } from "@/app/lib/recording-reviewer";
import { PRIVATE_RECORDING_HEADERS } from "@/app/lib/recordings";
import { getRecordingObject } from "@/app/lib/r2";
import { getSql } from "@/db";

type Context = {
  params: Promise<{ recordingId: string; segmentId: string }>;
};

function hiddenResponse() {
  return new Response("Not found", {
    status: 404,
    headers: PRIVATE_RECORDING_HEADERS,
  });
}

export async function GET(request: NextRequest, context: Context) {
  const reviewer = await recordingReviewer(request);
  if (!reviewer) return hiddenResponse();
  const { recordingId, segmentId } = await context.params;
  const rows = await getSql()`
    SELECT s.id,s.object_key AS "objectKey",s.mime_type AS "mimeType",
      s.segment_index AS "segmentIndex",r.match_id AS "matchId",
      r.participant_name AS "participantName"
    FROM recording_segments s
    JOIN match_recordings r ON r.id=s.recording_id
    WHERE s.id=${segmentId} AND s.recording_id=${recordingId}
      AND s.status='uploaded' AND r.expires_at>NOW() AND r.status<>'deleting'
    LIMIT 1
  `;
  const segment = rows[0];
  if (!segment) return hiddenResponse();

  const range = request.headers.get("range");
  if (
    range &&
    (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 80)
  ) {
    return new Response(null, {
      status: 416,
      headers: PRIVATE_RECORDING_HEADERS,
    });
  }
  const object = await getRecordingObject(String(segment.objectKey), range).catch(
    (error) => {
      console.error("Private recording object could not be read", error);
      return null;
    },
  );
  if (!object) return hiddenResponse();
  if (!object.Body) return hiddenResponse();

  // Browsers commonly request several byte ranges while seeking. Record the
  // initial playback access, while avoiding an audit row for every later seek.
  if (!range || range.startsWith("bytes=0-")) {
    await logAudit({
      actor: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
      action: "recording.playback",
      summary: `${reviewer.name} played ${segment.participantName}'s match recording`,
      targetType: "recording",
      targetId: recordingId,
      metadata: {
        matchId: segment.matchId,
        segmentId,
        segmentIndex: segment.segmentIndex,
      },
    });
  }

  const headers = new Headers(PRIVATE_RECORDING_HEADERS);
  const contentType = String(object.ContentType ?? segment.mimeType);
  const extension = contentType.startsWith("video/mp4") ? "mp4" : "webm";
  headers.set("Content-Type", contentType);
  headers.set("Accept-Ranges", "bytes");
  headers.set(
    "Content-Disposition",
    `inline; filename="recording-${recordingId}-${segment.segmentIndex}.${extension}"`,
  );
  if (object.ContentLength !== undefined) {
    headers.set("Content-Length", String(object.ContentLength));
  }
  if (object.ContentRange) headers.set("Content-Range", object.ContentRange);

  return new Response(object.Body.transformToWebStream(), {
    status: object.ContentRange ? 206 : 200,
    headers,
  });
}
