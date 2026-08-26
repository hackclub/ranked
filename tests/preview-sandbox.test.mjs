import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../app/RankedApp.tsx", import.meta.url);

test("preview bridge cannot be swallowed by malformed body markup", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /new DOMParser\(\)\.parseFromString\(base, "text\/html"\)/);
  assert.match(source, /doc\.head\.prepend\(navShimScript\)/);
  assert.doesNotMatch(source, /doc\.body\.appendChild\(navShimScript\)/);
});

test("preview updates only accept bounded HTML from the direct parent", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /e\.source !== window\.parent/);
  assert.match(source, /typeof e\.data\.html !== "string"/);
  assert.match(source, /e\.data\.html\.length > \$\{PREVIEW_MAX_HTML_LENGTH\}/);
});

test("untrusted website frames explicitly deny device capabilities", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /const PREVIEW_IFRAME_ALLOW =/);
  assert.match(source, /"camera 'none'"/);
  assert.match(source, /"microphone 'none'"/);
  assert.match(source, /sandbox="allow-scripts"\s+allow=\{PREVIEW_IFRAME_ALLOW\}/);
});
