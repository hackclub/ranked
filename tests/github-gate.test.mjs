import assert from "node:assert/strict";
import { test } from "node:test";

import { rankedPublishBlock } from "../app/lib/github.ts";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const FULL_PERMISSIONS = {
  contents: "write",
  pages: "write",
  administration: "write",
  metadata: "read",
};

const connection = (overrides = {}) => ({
  login: "octocat",
  accessToken: "ghu_token",
  avatarUrl: null,
  refreshToken: "ghr_token",
  accessTokenExpiresAt: Date.now() + 3_600_000,
  refreshTokenExpiresAt: Date.now() + 15_897_600_000,
  ...overrides,
});

const withStubbedFetch = async (responses, run) => {
  const originalFetch = globalThis.fetch;
  const queue = [...responses];
  globalThis.fetch = async () => queue.shift();
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test("queueing without a GitHub connection is blocked before the match starts", async () => {
  const block = await rankedPublishBlock(undefined);
  assert.equal(block.code, "github_install_required");
  assert.equal(block.problem, "not_connected");
});

test("an authorized but uninstalled app blocks the queue rather than the publish", async () => {
  const block = await withStubbedFetch(
    [json({ login: "octocat" }), json({ installations: [] })],
    () => rankedPublishBlock(connection()),
  );
  assert.equal(block.problem, "not_installed");
  assert.equal(
    block.installUrl,
    "https://github.com/apps/hack-club-ranked/installations/new",
  );
});

test("an installation awaiting permission approval blocks with what is missing", async () => {
  const block = await withStubbedFetch(
    [
      json({ login: "octocat" }),
      json({
        installations: [
          {
            id: 1,
            app_slug: "hack-club-ranked",
            permissions: { pages: "write", administration: "write" },
          },
        ],
      }),
    ],
    () => rankedPublishBlock(connection()),
  );
  assert.equal(block.problem, "permissions_pending");
  assert.deepEqual(block.missingPermissions, ["contents"]);
});

test("a working installation does not block the queue", async () => {
  const block = await withStubbedFetch(
    [
      json({ login: "octocat" }),
      json({
        installations: [
          { id: 1, app_slug: "hack-club-ranked", permissions: FULL_PERMISSIONS },
        ],
      }),
      json({ html_url: "https://example.test/octocat/hackclubranked" }),
    ],
    () => rankedPublishBlock(connection()),
  );
  assert.equal(block, null);
});

test("an unreachable GitHub never holds matchmaking closed", async () => {
  const block = await withStubbedFetch(
    [json({ login: "octocat" }), json({ message: "Server Error" }, 500)],
    () => rankedPublishBlock(connection()),
  );
  assert.equal(block, null);
});

test("a token too near expiry to spend a rotating refresh on is left unchecked", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json({});
  };
  try {
    assert.equal(
      await rankedPublishBlock(
        connection({ accessTokenExpiresAt: Date.now() - 1 }),
      ),
      null,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
