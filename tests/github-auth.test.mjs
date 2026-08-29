import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configureRankedRepoForPages,
  exchangeGitHubCode,
  GitHubCredentialsError,
  GitHubPagesPermissionError,
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
      GitHubPagesPermissionError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
