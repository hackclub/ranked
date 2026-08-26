import assert from "node:assert/strict";
import test from "node:test";
import { clearAllMatches } from "../scripts/clear-matches.mjs";

test("clearAllMatches deletes matches and pending queue entries", async () => {
  let statement = "";
  const sql = async (strings) => {
    statement = strings.join("");
    return [{ matches: "4", queue_entries: "2" }];
  };

  const result = await clearAllMatches(sql);

  assert.match(statement, /DELETE FROM matches/);
  assert.match(statement, /DELETE FROM matchmaking_queue/);
  assert.deepEqual(result, { matches: 4, queueEntries: 2 });
});
