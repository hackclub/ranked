import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";

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
  config({ path: ".env.local" });

  const confirmation = "CLEAR_ALL_MATCHES";
  const confirmIndex = process.argv.indexOf("--confirm");
  const confirmed =
    confirmIndex !== -1 && process.argv[confirmIndex + 1] === confirmation;

  if (!confirmed) {
    console.error("Match cleanup cancelled.");
    console.error(
      `Run: npm run db:clear-matches -- --confirm ${confirmation}`,
    );
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not configured. Set it in .env.local or the environment.",
    );
    process.exitCode = 1;
    return;
  }

  let target;
  try {
    const parsed = new URL(databaseUrl);
    target = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exitCode = 1;
    return;
  }

  console.log(`Clearing all Ranked matches from ${target}...`);
  const deleted = await clearAllMatches(neon(databaseUrl));
  console.log("Match cleanup complete.");
  console.log("Deleted:", deleted);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runFromCommandLine().catch((error) => {
    console.error("Match cleanup failed.", error);
    process.exitCode = 1;
  });
}
