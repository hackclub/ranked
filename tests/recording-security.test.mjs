import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyPath = new URL("../app/lib/recording-policy.ts", import.meta.url);
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

test("recording review authorization is a fixed two-email server allowlist", async () => {
  const policy = await readFile(policyPath, "utf8");
  const listRoute = await readFile(reviewListPath, "utf8");
  const playbackRoute = await readFile(playbackPath, "utf8");

  assert.match(policy, /"mihir@hackclub\.com"/);
  assert.match(policy, /"meghana@hackclub\.com"/);
  assert.match(policy, /email\.trim\(\)\.toLowerCase\(\)/);
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
