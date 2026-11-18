import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the app sets the same security headers vercel.json does", async () => {
  const vercel = JSON.parse(await read("../vercel.json"));
  const nextConfig = await read("../next.config.ts");

  assert.match(nextConfig, /async headers\(\)/);
  for (const rule of vercel.headers) {
    for (const { key, value } of rule.headers) {
      assert.ok(
        nextConfig.includes(`{ key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} }`),
        `next.config.ts is missing ${key}: ${value}`,
      );
    }
  }

  // Every path is covered, and the stricter recording-review rule is listed
  // before the catch-all rules it overlaps with (the first match wins).
  const review = nextConfig.indexOf('{ source: "/reviewer/recordings", headers: recordingReviewHeaders }');
  const root = nextConfig.indexOf('{ source: "/", headers: appHeaders }');
  const rest = nextConfig.indexOf('{ source: "/:path*", headers: appHeaders }');
  assert.ok(review > 0 && root > review && rest > review, "header rules are missing or out of order");
});

test("match lifecycle is only reported to players in the match", async () => {
  const heartbeat = await read("../app/api/matches/[matchId]/heartbeat/route.ts");

  const guard = heartbeat.indexOf("if (!recording.participant)");
  assert.ok(guard > 0, "heartbeat must reject non-participants");
  // Nothing about the match may be read, and no forfeit finalized, before
  // the caller is known to be in it.
  for (const call of ["pendingDisconnect(matchId)", "finalizeForfeit(", "matchOutcome(matchId)"]) {
    assert.ok(heartbeat.indexOf(call) > guard, `${call} runs before the participant check`);
  }
});

test("Slack member IDs are never sent to other players", async () => {
  const sources = await Promise.all([
    read("../app/api/friends/route.ts"),
    read("../app/api/dashboard/route.ts"),
    read("../app/api/liveblocks-auth/route.ts"),
    read("../app/api/friends/directory/route.ts"),
    read("../app/api/users/[userId]/profile/route.ts"),
    read("../app/api/leaderboard/route.ts"),
    read("../liveblocks.config.ts"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /slack_id|slackId/);
  }
});

test("shop orders store shipping addresses encrypted", async () => {
  const route = await read("../app/api/shop/orders/route.ts");
  const shipping = await read("../app/lib/shipping.ts");

  assert.match(route, /JSON\.stringify\(await encryptShipping\(shipping\)\)/);
  assert.doesNotMatch(route, /JSON\.stringify\(shipping\)/);
  assert.match(shipping, /aesGcmEncrypt/);
  // The address must never be returned by the orders API.
  assert.doesNotMatch(route, /SELECT[^`]*\bshipping\b[^`]*FROM shop_orders/);
});

test("the account id never falls back to an email address", async () => {
  const callback = await read("../app/api/auth/hackclub/callback/route.ts");

  assert.doesNotMatch(callback, /identity\.id \?\? email/);
  assert.match(callback, /did not return an account id/);
});

test("internal errors are not returned from the publish route", async () => {
  const publish = await read("../app/api/github/publish/route.ts");

  assert.doesNotMatch(publish, /error instanceof Error \? error\.message/);
  assert.match(publish, /error instanceof PublishInputError/);
});

test("published-page checks connect to the address that was validated", async () => {
  const safeFetch = await read("../app/lib/safe-fetch.ts");

  assert.match(safeFetch, /lookup: pinnedLookup/);
  assert.match(safeFetch, /agent: false/);
  // fetch() resolves the hostname again on its own, which is the gap.
  assert.doesNotMatch(safeFetch, /\bfetch\(/);
});

test("spreadsheet formulas are defused in every player-controlled Airtable field", async () => {
  const airtable = await read("../app/lib/airtable.ts");

  for (const field of ["githubUsername", "firstName", "lastName", "line1", "city", "state", "country", "postalCode"]) {
    assert.match(
      airtable,
      new RegExp(`\\[SUBMISSION_FIELDS\\.${field}\\.id\\]: airtableCell\\(`),
      `${field} is written without airtableCell()`,
    );
  }
  assert.match(airtable, /fields\[SUBMISSION_FIELDS\.line2\.id\] = line2/);
});

test("abuse-prone routes are rate limited", async () => {
  const routes = [
    "../app/api/matches/[matchId]/report/route.ts",
    "../app/api/friends/route.ts",
    "../app/api/friends/directory/route.ts",
    "../app/api/github/pages-status/route.ts",
    "../app/api/github/publish/route.ts",
    "../app/api/recordings/session/route.ts",
    "../app/api/recordings/[recordingId]/segments/route.ts",
    "../app/api/shop/orders/route.ts",
    "../app/api/duo-invites/route.ts",
    "../app/api/votes/route.ts",
    "../app/api/profile/route.ts",
    "../app/api/airtable/submissions/route.ts",
    "../app/api/liveblocks-auth/route.ts",
  ];
  for (const route of routes) {
    assert.match(await read(route), /await rateLimited\(`[a-z-]+:\$\{/, `${route} has no rate limit`);
  }
});
