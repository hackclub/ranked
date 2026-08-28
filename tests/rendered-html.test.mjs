import assert from "node:assert/strict";
import { before, test } from "node:test";

let handler;

before(async () => {
  const deployment = await import(
    "../.vercel/output/functions/__server.func/index.mjs"
  );
  handler = deployment.default;
});

async function render() {
  return handler.fetch(
    new Request("https://ranked.example/", {
      headers: { accept: "text/html" },
    }),
    { waitUntil() {} },
  );
}

test("server-renders the Ranked product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Hack Club Ranked/);
  assert.match(html, /HACK CLUB/);
  assert.match(html, /goofy-guy-avatar/);
  assert.match(html, /goofyguys\/shapes\/2\.png/);
  assert.match(html, /daily challenges/);
  assert.match(html, /sign in to play/);
  assert.match(html, /Hack Club account required/);
  assert.doesNotMatch(html, /Building your site|react-loading-skeleton/);
});

test("includes product navigation and share metadata", async () => {
  const html = await (await render()).text();
  assert.match(html, /shop/);
  assert.match(html, /leaderboard/);
  assert.match(html, /og\.png/);
  assert.match(html, /Build fast\. Ship open\./);
});

test("logout expires site cookies and requests browser storage cleanup", async () => {
  const response = await handler.fetch(
    new Request("https://ranked.example/api/auth/logout", {
      method: "POST",
      headers: {
        accept: "application/json",
        cookie: "ranked_session=session; ranked_github_state=state; site_preference=value",
      },
    }),
    { waitUntil() {} },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("clear-site-data"), '"cache", "cookies", "storage"');
  const setCookies = response.headers.getSetCookie().join("\n");
  assert.match(setCookies, /ranked_session=;/);
  assert.match(setCookies, /ranked_github_state=;/);
  assert.match(setCookies, /site_preference=;/);
  assert.match(setCookies, /Max-Age=0/i);
});
