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
  assert.match(html, /Ranked — livecoding for builders/);
  assert.match(html, /HACK CLUB/);
  assert.match(html, /daily challenges/);
  assert.match(html, /sign in to play/);
  assert.match(html, /Hack Club account required/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});

test("includes product navigation and share metadata", async () => {
  const html = await (await render()).text();
  assert.match(html, /shop/);
  assert.match(html, /leaderboard/);
  assert.match(html, /og\.png/);
  assert.match(html, /Build fast\. Ship open\./);
});
