import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configureRankedRepoForPages,
  exchangeGitHubCode,
  GitHubCredentialsError,
  GitHubPermissionError,
  githubInstallUrl,
  publishWebsite,
  rankedAccessStatus,
  refreshGitHubConnection,
} from "../app/lib/github.ts";

test("GitHub App credentials retain and rotate expiring user tokens", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.GITHUB_CLIENT_ID;
  const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";

  try {
    const issuedAt = Date.now();
    const exchangeResponses = [
      new Response(
        JSON.stringify({
          access_token: "ghu_old",
          expires_in: 28_800,
          refresh_token: "ghr_old",
          refresh_token_expires_in: 15_897_600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      new Response(
        JSON.stringify({ login: "octocat", avatar_url: "https://example.test/avatar.png" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ];
    globalThis.fetch = async () => exchangeResponses.shift();

    const connection = await exchangeGitHubCode(
      "code",
      "verifier",
      "https://ranked.example/api/auth/github/callback",
    );
    assert.equal(connection.accessToken, "ghu_old");
    assert.equal(connection.refreshToken, "ghr_old");
    assert.ok(connection.accessTokenExpiresAt >= issuedAt + 28_799_000);
    assert.ok(connection.refreshTokenExpiresAt >= issuedAt + 15_897_599_000);

    let refreshRequest;
    globalThis.fetch = async (url, init) => {
      refreshRequest = { url, init };
      return new Response(
        JSON.stringify({
          access_token: "ghu_new",
          expires_in: 28_800,
          refresh_token: "ghr_new",
          refresh_token_expires_in: 15_897_600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const refreshed = await refreshGitHubConnection({
      ...connection,
      accessTokenExpiresAt: Date.now() - 1,
    });

    assert.equal(refreshed.accessToken, "ghu_new");
    assert.equal(refreshed.refreshToken, "ghr_new");
    assert.equal(refreshRequest.url, "https://github.com/login/oauth/access_token");
    assert.equal(refreshRequest.init.method, "POST");
    assert.equal(refreshRequest.init.body.get("grant_type"), "refresh_token");
    assert.equal(refreshRequest.init.body.get("refresh_token"), "ghr_old");

    await assert.rejects(
      refreshGitHubConnection({
        login: "octocat",
        avatarUrl: null,
        accessToken: "expired-legacy-token",
        accessTokenExpiresAt: Date.now() - 1,
      }),
      GitHubCredentialsError,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined)
      delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = originalClientSecret;
  }
});

test("GitHub Pages checks existing configuration before requesting administration access", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url, method: init.method ?? "GET" });
      return new Response(JSON.stringify({ html_url: "https://example.test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await configureRankedRepoForPages("token", "octocat");
    assert.deepEqual(requests, [
      {
        url: "https://api.github.com/repos/octocat/hackclubranked/pages",
        method: "GET",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub Pages reports the installation permission upgrade when creation is forbidden", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const responses = [
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ];
    globalThis.fetch = async () => responses.shift();

    await assert.rejects(
      configureRankedRepoForPages("token", "octocat"),
      GitHubPermissionError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publishing reports the installation permission upgrade when the commit is forbidden", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const json = (body, status) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const responses = [
      json({ login: "octocat" }, 200), // currentGitHubLogin
      json({ html_url: "https://example.test/octocat/hackclubranked" }, 200), // ensureRankedRepo repo check
      json({}, 200), // configureRankedRepoForPages: Pages already enabled
      json({ message: "Not Found" }, 404), // pathExists(folderName): not taken yet
      json({ object: { sha: "base-sha" } }, 200), // commitFiles ref
      json({ tree: { sha: "base-tree-sha" } }, 200), // commitFiles base commit
      json({ message: "Resource not accessible by integration" }, 403), // commitFiles tree creation
    ];
    globalThis.fetch = async () => responses.shift();

    await assert.rejects(
      publishWebsite(
        "token",
        "octocat",
        "my-build",
        "theme",
        { "index.html": "<html></html>" },
        undefined,
        undefined,
        [],
      ),
      (error) =>
        error instanceof GitHubPermissionError &&
        /Contents permissions/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("onboarding points at the installation URL, which is what grants repo access", () => {
  assert.equal(
    githubInstallUrl(),
    "https://github.com/apps/hack-club-ranked/installations/new",
  );
  assert.equal(
    githubInstallUrl("abc123"),
    "https://github.com/apps/hack-club-ranked/installations/new?state=abc123",
  );
});

test("a code from the installation flow is exchanged without a PKCE verifier", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.GITHUB_CLIENT_ID;
  const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  try {
    const bodies = [];
    const responses = [
      new Response(JSON.stringify({ access_token: "ghu_token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    globalThis.fetch = async (url, init = {}) => {
      if (init.body) bodies.push(JSON.parse(init.body));
      return responses.shift();
    };

    await exchangeGitHubCode(
      "code",
      null,
      "https://ranked.example/api/auth/github/callback",
    );
    assert.equal("code_verifier" in bodies[0], false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined)
      delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = originalClientSecret;
  }
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

const FULL_PERMISSIONS = {
  contents: "write",
  pages: "write",
  administration: "write",
  metadata: "read",
};

test("authorizing without installing is reported, not mistaken for a working connection", async () => {
  const status = await withStubbedFetch(
    [json({ login: "octocat" }), json({ installations: [] })],
    () => rankedAccessStatus("token", "octocat"),
  );
  assert.equal(status.problem, "not_installed");
  assert.equal(status.installUrl, githubInstallUrl());
});

test("an installation still on the app's older permissions is reported as pending", async () => {
  const status = await withStubbedFetch(
    [
      json({ login: "octocat" }),
      json({
        installations: [
          {
            id: 1,
            app_slug: "hack-club-ranked",
            permissions: { pages: "write", metadata: "read" },
          },
        ],
      }),
    ],
    () => rankedAccessStatus("token", "octocat"),
  );
  assert.equal(status.problem, "permissions_pending");
  assert.deepEqual(status.missingPermissions, ["administration", "contents"]);
  // Straight to the installation's own page, where the "Review request"
  // prompt lives — not the list of every app they've installed.
  assert.equal(
    status.settingsUrl,
    "https://github.com/settings/installations/1",
  );
});

test("an installation that cannot see a hackclubranked repo is reported", async () => {
  const status = await withStubbedFetch(
    [
      json({ login: "octocat" }),
      json({
        installations: [
          { id: 1, app_slug: "hack-club-ranked", permissions: FULL_PERMISSIONS },
        ],
      }),
      json({ message: "Not Found" }, 404),
    ],
    () => rankedAccessStatus("token", "octocat"),
  );
  assert.equal(status.problem, "repo_not_accessible");
});

test("a fully granted installation reports no problem", async () => {
  const status = await withStubbedFetch(
    [
      json({ login: "octocat" }),
      json({
        installations: [
          { id: 1, app_slug: "another-app", permissions: {} },
          { id: 2, app_slug: "hack-club-ranked", permissions: FULL_PERMISSIONS },
        ],
      }),
      json({ html_url: "https://example.test/octocat/hackclubranked" }),
    ],
    () => rankedAccessStatus("token", "octocat"),
  );
  assert.equal(status.problem, null);
  assert.equal(status.login, "octocat");
});

test("an unreadable permissions map is not mistaken for missing permissions", async () => {
  // GitHub returning an installation without a permissions map means "we
  // didn't tell you", not "you have none" — inventing a pending approval
  // here would send players to a page with nothing to approve.
  for (const permissions of [undefined, {}]) {
    const status = await withStubbedFetch(
      [
        json({ login: "octocat" }),
        json({
          installations: [
            { id: 7, app_slug: "hack-club-ranked", permissions },
          ],
        }),
        json({ html_url: "https://example.test/octocat/hackclubranked" }),
      ],
      () => rankedAccessStatus("token", "octocat"),
    );
    assert.equal(status.problem, null);
    assert.deepEqual(status.missingPermissions, []);
  }
});
