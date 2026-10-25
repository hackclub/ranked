import { connect, databaseFromEnv, hasConfirmation, runIfInvokedDirectly } from "./db.mjs";

/**
 * Permanently removes every match and its foreign-key-dependent records.
 * Pending matchmaking entries are also cleared so they cannot immediately
 * recreate a match after maintenance finishes.
 *
 * User accounts and their current ELO, balances, coding totals, challenges,
 * friendships, OAuth connections, and shop orders are intentionally preserved.
 */
export async function clearAllMatches(sql) {
  const [deleted] = await sql`
    WITH deleted_matches AS (
      DELETE FROM matches
      RETURNING id
    ), deleted_queue_entries AS (
      DELETE FROM matchmaking_queue
      RETURNING user_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM deleted_matches) AS matches,
      (SELECT COUNT(*)::int FROM deleted_queue_entries) AS queue_entries
  `;

  return {
    matches: Number(deleted?.matches ?? 0),
    queueEntries: Number(deleted?.queue_entries ?? 0),
  };
}

async function runFromCommandLine() {
  if (!hasConfirmation("CLEAR_ALL_MATCHES", "db:clear-matches", "Match cleanup cancelled.")) {
    return;
  }

  const database = databaseFromEnv();
  if (!database) return;

  console.log(`Clearing all Ranked matches from ${database.target}...`);
  const deleted = await clearAllMatches(connect(database.url));
  console.log("Match cleanup complete.");
  console.log("Deleted:", deleted);
}

runIfInvokedDirectly(import.meta.url, runFromCommandLine, "Match cleanup failed.");
