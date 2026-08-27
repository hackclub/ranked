import { getSql } from "@/db";
import { deleteRecordingObjects } from "@/app/lib/r2";
import type { NextRequest } from "next/server";

type ExpiredRecordingRow = {
  id: string;
  objectKeys: string[] | null;
};

export async function purgeExpiredRecordings(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = (await getSql().query(
    `SELECT r.id,
      COALESCE(array_agg(s.object_key) FILTER (WHERE s.object_key IS NOT NULL), ARRAY[]::text[]) AS "objectKeys"
    FROM match_recordings r
    LEFT JOIN recording_segments s ON s.recording_id=r.id
    WHERE r.expires_at<=NOW()
    GROUP BY r.id,r.expires_at
    ORDER BY r.expires_at
    LIMIT $1`,
    [boundedLimit],
  )) as ExpiredRecordingRow[];

  if (!rows.length) return { recordingsDeleted: 0, objectsDeleted: 0 };

  // Delete object bytes before metadata so a transient R2 failure can never
  // leave an untracked recording behind. Both operations are batched; a busy
  // expiry day must not turn into hundreds of sequential serverless calls.
  const objectKeys = rows.flatMap((row) => row.objectKeys ?? []);
  await deleteRecordingObjects(objectKeys);
  const recordingIds = rows.map((row) => row.id);
  await getSql().query(
    "DELETE FROM match_recordings WHERE id=ANY($1::text[]) AND expires_at<=NOW()",
    [recordingIds],
  );
  return {
    recordingsDeleted: recordingIds.length,
    objectsDeleted: objectKeys.length,
  };
}

export const PRIVATE_RECORDING_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=()",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
} as const;

export function isSameOriginMutation(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");
  if (!host) return false;
  const protocol =
    request.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  return origin === `${protocol}://${host}`;
}
