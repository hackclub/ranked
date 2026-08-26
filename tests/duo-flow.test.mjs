import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const queueRoutePath = new URL(
  "../app/api/matchmaking/queue/route.ts",
  import.meta.url,
);
const inviteRoutePath = new URL(
  "../app/api/duo-invites/route.ts",
  import.meta.url,
);
const appPath = new URL("../app/RankedApp.tsx", import.meta.url);

test("duo matchmaking preserves invited parties and randomly fills empty teammate slots", async () => {
  const source = await readFile(queueRoutePath, "utf8");

  assert.match(source, /q\.party_key IS NULL/);
  assert.match(source, /INSERT INTO duo_invites[\s\S]*'accepted'/);
  assert.match(source, /HAVING COUNT\(\*\)=2 AND BOOL_AND/);
  assert.match(source, /COUNT\(\*\) FROM own_teammate\)=1/);
  assert.match(source, /COUNT\(\*\) FROM opponents\)=2/);
  assert.match(source, /duo_invite_pending/);
});

test("duo state changes clear stale queue membership", async () => {
  const source = await readFile(inviteRoutePath, "utf8");

  assert.match(source, /participant_locks/);
  assert.match(source, /cleared_queue/);
  assert.match(source, /DELETE FROM matchmaking_queue/);
  assert.match(source, /PENDING_INVITE_TTL/);
});

test("interactive matchmaking requests time out and recover from an idle queue", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /INTERACTIVE_REQUEST_TIMEOUT_MS/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /result\.status === "idle"/);
  assert.match(source, /Matchmaking stopped — ready up again/);
});

test("invited teammates can see, but cannot change, leader-owned settings", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /hud-block-locked/);
  assert.match(source, /set by team leader/);
  assert.match(source, /disabled=\{matching \|\| isDuoJoiner\}/);
  assert.match(source, /className=\{effectiveLength === time \? "active" : ""\}/);
});
