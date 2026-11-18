import { getSql } from "@/db";
import { deleteRecordingObjects, recordingStorageConfigured } from "@/app/lib/r2";
import { logAudit } from "@/app/lib/audit";
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

// How long a player may be in a live match without a clip reaching storage
// before their recording counts as missing. Clips are 10 seconds long and are
// retried on upload, so a working client lands one well inside this window.
const RECORDING_STALE_SECONDS = 60;

// The safety recording is produced by each player's own browser, so the server
// can't make it happen — but it can notice when it isn't happening. Enforcement
// is on whenever recording storage is configured; RECORDING_ENFORCEMENT=off is
// the escape hatch for a storage outage (calls then run unrecorded, exactly as
// they do on a deployment with no storage at all).
export function recordingEnforced() {
  return recordingStorageConfigured() && process.env.RECORDING_ENFORCEMENT !== "off";
}

export type RecordingHealth = {
  participant: boolean;
  // Inside the match's timed window — the only time its call is open.
  live: boolean;
  // False once a player has been in a live match past the grace period with no
  // clip uploaded recently. Always true when enforcement is off.
  ok: boolean;
};

export async function recordingHealth(matchId: string, userId: string): Promise<RecordingHealth> {
  const rows = await getSql()`
    SELECT
      (m.status='active' AND m.started_at<=NOW() AND NOW()<m.ends_at) AS live,
      (
        -- Grace: the match, or this player's time in it, has only just begun.
        -- presence_confirmed_at is set once by the first heartbeat and never
        -- moves, so a client can't keep itself inside the grace period.
        m.started_at>NOW()-(${RECORDING_STALE_SECONDS}||' seconds')::interval
        OR COALESCE(mp.presence_confirmed_at,NOW())>NOW()-(${RECORDING_STALE_SECONDS}||' seconds')::interval
        OR EXISTS (
          SELECT 1 FROM match_recordings r
          JOIN recording_segments s ON s.recording_id=r.id
          WHERE r.match_id=mp.match_id AND r.user_id=mp.user_id
            AND s.status='uploaded'
            AND s.uploaded_at>NOW()-(${RECORDING_STALE_SECONDS}||' seconds')::interval
        )
      ) AS recorded
    FROM match_players mp JOIN matches m ON m.id=mp.match_id
    WHERE mp.match_id=${matchId} AND mp.user_id=${userId}
    LIMIT 1
  `;
  const row = rows[0] as { live: boolean; recorded: boolean } | undefined;
  if (!row) return { participant: false, live: false, ok: false };
  return {
    participant: true,
    live: row.live,
    ok: !recordingEnforced() || !row.live || row.recorded,
  };
}

// Leaves one audit entry per player per match the first time their recording
// goes missing, so a reviewer looking into a report can see that a player was
// in the call without one. Bounded to recent rows so the existence check can
// use the audit log's created_at index.
export async function flagMissingRecording(
  matchId: string,
  user: { id: string; name: string; email: string },
) {
  try {
    const existing = await getSql()`
      SELECT 1 FROM audit_log
      WHERE created_at>NOW()-INTERVAL '6 hours' AND action='recording.missing'
        AND target_id=${matchId} AND actor_id=${user.id}
      LIMIT 1
    `;
    if (existing.length) return;
    await logAudit({
      actor: { id: user.id, name: user.name, email: user.email },
      action: "recording.missing",
      summary: `${user.name} was in a live match with no safety recording reaching storage`,
      targetType: "match",
      targetId: matchId,
      metadata: { staleAfterSeconds: RECORDING_STALE_SECONDS },
    });
  } catch (error) {
    console.error("Could not flag a missing recording", error);
  }
}
