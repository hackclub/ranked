import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
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
