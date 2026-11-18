import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyPath = new URL("../app/lib/recording-policy.ts", import.meta.url);
const staffPath = new URL("../app/lib/admin.ts", import.meta.url);
const reviewerPath = new URL("../app/lib/recording-reviewer.ts", import.meta.url);
const heartbeatPath = new URL(
  "../app/api/matches/[matchId]/heartbeat/route.ts",
  import.meta.url,
);
const liveblocksAuthPath = new URL("../app/api/liveblocks-auth/route.ts", import.meta.url);
const realtimeHookPath = new URL("../app/realtime/useRealtimeRoom.ts", import.meta.url);
const queuePath = new URL("../app/api/matchmaking/queue/route.ts", import.meta.url);
const sessionPath = new URL("../app/api/recordings/session/route.ts", import.meta.url);
const reviewListPath = new URL("../app/api/reviewer/recordings/route.ts", import.meta.url);
const playbackPath = new URL(
  "../app/api/reviewer/recordings/[recordingId]/segments/[segmentId]/route.ts",
  import.meta.url,
);
const recordingsPath = new URL("../app/lib/recordings.ts", import.meta.url);
const r2Path = new URL("../app/lib/r2.ts", import.meta.url);
const appPath = new URL("../app/RankedApp.tsx", import.meta.url);
const recordingHookPath = new URL(
  "../app/realtime/useMatchRecording.ts",
  import.meta.url,
);
const segmentRoutePath = new URL(
  "../app/api/recordings/[recordingId]/segments/route.ts",
  import.meta.url,
);
const deleteRoutePath = new URL(
  "../app/api/reviewer/recordings/[recordingId]/route.ts",
  import.meta.url,
);
const reviewDashboardPath = new URL(
  "../app/reviewer/recordings/RecordingReviewDashboard.tsx",
  import.meta.url,
);

test("recording review authorization is a server-side allowlist read from configuration", async () => {
  const policy = await readFile(policyPath, "utf8");
  const staff = await readFile(staffPath, "utf8");
  const reviewer = await readFile(reviewerPath, "utf8");
  const app = await readFile(appPath, "utf8");
  const listRoute = await readFile(reviewListPath, "utf8");
  const playbackRoute = await readFile(playbackPath, "utf8");

  // Who has access is deployment configuration, not source: no staff address
  // may be written into the repository, and the list must never be imported
  // into the client bundle.
  for (const source of [policy, staff, app]) {
    assert.doesNotMatch(source, /[a-z0-9._-]+@hackclub\.com/i);
  }
  assert.match(staff, /"RECORDING_REVIEWER_EMAILS"/);
  assert.match(staff, /"ADMIN_EMAILS"/);
  assert.match(staff, /email\.trim\(\)\.toLowerCase\(\)/);
  assert.match(reviewer, /isRecordingReviewer\(user\.email\)/);
  assert.doesNotMatch(app, /lib\/admin/);
  assert.match(listRoute, /recordingReviewer\(request\)/);
  assert.match(playbackRoute, /recordingReviewer\(request\)/);
  assert.match(playbackRoute, /PRIVATE_RECORDING_HEADERS/);
  assert.match(playbackRoute, /r\.expires_at>NOW\(\)/);
  assert.doesNotMatch(playbackRoute, /signedRecordingUploadUrl/);
});

test("matchmaking and recording sessions require persisted affirmative consent", async () => {
  const queue = await readFile(queuePath, "utf8");
  const session = await readFile(sessionPath, "utf8");
  const app = await readFile(appPath, "utf8");

  assert.match(queue, /body\.recordingConsent !== true/);
  assert.match(queue, /recording_consented_at/);
  assert.match(queue, /INSERT INTO match_recording_consents/);
  assert.match(session, /JOIN match_recording_consents/);
  assert.match(app, /recordingConsentCopy\(\)/);
  assert.match(app, /recordingConsent: true/);
  assert.match(app, /match-recording-indicator/);
});

test("recordings expire after ten days and are served without caching", async () => {
  const policy = await readFile(policyPath, "utf8");
  const session = await readFile(sessionPath, "utf8");
  const playback = await readFile(playbackPath, "utf8");
  const recordings = await readFile(recordingsPath, "utf8");
  const r2 = await readFile(r2Path, "utf8");

  assert.match(policy, /RECORDING_RETENTION_DAYS = 10/);
  assert.match(session, /RECORDING_RETENTION_DAYS/);
  assert.match(recordings, /"Cache-Control": "private, no-store/);
  assert.match(recordings, /"Cross-Origin-Resource-Policy": "same-origin"/);
  assert.match(r2, /recordingStorageConfigured/);
  assert.match(playback, /recording\.playback/);
});

test("recording clips use the authenticated same-origin upload proxy", async () => {
  const hook = await readFile(recordingHookPath, "utf8");
  const route = await readFile(segmentRoutePath, "utf8");

  assert.match(hook, /method: "PUT"/);
  assert.match(hook, /\/api\/recordings\/\$\{encodeURIComponent\(recordingId\)\}\/segments/);
  assert.doesNotMatch(hook, /prepared\.uploadUrl/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /isSameOriginMutation\(request\)/);
  assert.match(route, /r\.user_id=\$\{user\.id\}/);
  assert.match(route, /putRecordingObject/);
});

test("only reviewers can permanently delete a recording and its private objects", async () => {
  const route = await readFile(deleteRoutePath, "utf8");
  const dashboard = await readFile(reviewDashboardPath, "utf8");

  assert.match(route, /export async function DELETE/);
  assert.match(route, /recordingReviewer\(request\)/);
  assert.match(route, /isSameOriginMutation\(request\)/);
  assert.match(route, /deleteRecordingObjects\(objectKeys\)/);
  assert.match(route, /DELETE FROM match_recordings/);
  assert.match(route, /action: "recording\.deleted"/);
  assert.match(dashboard, /window\.confirm/);
  assert.match(dashboard, /method: "DELETE"/);
  assert.match(dashboard, /delete recording/);
});

test("a call is only open while the match is live and its recording is arriving", async () => {
  const recordings = await readFile(recordingsPath, "utf8");
  const heartbeat = await readFile(heartbeatPath, "utf8");
  const liveblocksAuth = await readFile(liveblocksAuthPath, "utf8");
  const realtimeHook = await readFile(realtimeHookPath, "utf8");
  const recordingHook = await readFile(recordingHookPath, "utf8");
  const app = await readFile(appPath, "utf8");

  // The server decides whether a recording is healthy, from clips that have
  // actually reached storage, and tells the client on every heartbeat.
  assert.match(recordings, /export async function recordingHealth/);
  assert.match(recordings, /s\.status='uploaded'/);
  assert.match(heartbeat, /recordingOk: recording\.ok/);
  assert.match(heartbeat, /flagMissingRecording\(matchId, user\)/);

  // No call token once the match is over, or while nothing is being recorded.
  assert.match(liveblocksAuth, /if \(!recording\.live\)/);
  assert.match(liveblocksAuth, /if \(!recording\.ok\)/);

  // The client leaves the call when the match ends and stops sending media
  // while the server reports the recording missing.
  assert.match(realtimeHook, /if \(!activeRtcConfig \|\| !enabled\) return;/);
  assert.match(realtimeHook, /sender\.track\.enabled = transmit &&/);
  assert.match(app, /\{ enabled: callLive, transmit: recordingOk \}/);
  assert.match(app, /setRecordingOk\(result\.recordingOk\)/);
  assert.match(recordingHook, /retryTimer = window\.setTimeout/);
});
