import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { neon, neonConfig } from "@neondatabase/serverless";
import { config } from "dotenv";

// Mirrors db/index.ts: against a local Postgres, Neon's HTTP driver has to
// be routed through local-neon-http-proxy (see docker-compose.yml) instead
// of resolving Neon's own cloud endpoint.
function isLocalDatabaseUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function connect(databaseUrl) {
  if (isLocalDatabaseUrl(databaseUrl)) {
    neonConfig.fetchEndpoint = (host) => `http://${host}:4444/sql`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.poolQueryViaFetch = true;
  }
  return neon(databaseUrl);
}

/**
 * Creates fake "finished, awaiting votes" matches so the /vote screen has
 * something to show locally without actually playing a match end-to-end.
 * Reuses the seed-voter-* bot accounts as the two "players" and points both
 * builds at stable, freely-iframeable public pages (example.com and the
 * first website ever published) rather than fetching anything real.
 */
const THEMES = [
  "retro arcade",
  "cozy cottagecore",
  "deep space station",
  "neon cyberpunk city",
  "underwater research lab",
];

const BUILDS = [
  {
    description: "A pixel-art arcade cabinet with a couple of playable mini-games.",
    pagesUrl: "https://example.com",
    repositoryUrl: "https://github.com/hackclub/ranked-seed-build-a",
    githubRepo: "ranked-seed-build-a",
  },
  {
    description: "A minimal single-page site with a scrolling parallax hero section.",
    pagesUrl: "https://info.cern.ch",
    repositoryUrl: "https://github.com/hackclub/ranked-seed-build-b",
    githubRepo: "ranked-seed-build-b",
  },
];

export async function seedVoteMatches(sql, count = 3) {
  const bots = await sql`SELECT id FROM users WHERE id LIKE 'seed-voter-%' ORDER BY id`;
  if (bots.length < 2) {
    throw new Error(
      "Need at least 2 seed-voter-* users in the database — none found (or fewer than 2).",
    );
  }

  const created = [];
  for (let i = 0; i < count; i++) {
    const matchId = randomUUID();
    const theme = THEMES[i % THEMES.length];
    const blueUser = bots[(i * 2) % bots.length].id;
    const redUser = bots[(i * 2 + 1) % bots.length].id;
    const [buildA, buildB] = BUILDS;

    await sql.transaction([
      sql`INSERT INTO matches
          (id, mode, duration_minutes, theme, status, started_at, ends_at, voting_ends_at)
        VALUES
          (${matchId}, 'solo', 30, ${theme}, 'voting',
            NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '24 hours')`,
      sql`INSERT INTO match_players (match_id, user_id, team, slot, pre_elo, finished_at)
        VALUES
          (${matchId}, ${blueUser}, 'blue', 0, 1500, NOW() - INTERVAL '10 minutes'),
          (${matchId}, ${redUser}, 'red', 1, 1500, NOW() - INTERVAL '10 minutes')`,
      sql`INSERT INTO publications
          (id, match_id, team, repository_url, pages_url, github_repo, description, published_by)
        VALUES
          (${randomUUID()}, ${matchId}, 'blue', ${buildA.repositoryUrl}, ${buildA.pagesUrl}, ${buildA.githubRepo}, ${buildA.description}, ${blueUser}),
          (${randomUUID()}, ${matchId}, 'red', ${buildB.repositoryUrl}, ${buildB.pagesUrl}, ${buildB.githubRepo}, ${buildB.description}, ${redUser})`,
    ]);
    created.push({ matchId, theme, blueUser, redUser });
  }
  return created;
}

async function runFromCommandLine() {
  config({ path: ".env.local" });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured. Set it in .env.local or the environment.");
    process.exitCode = 1;
    return;
  }

  const countArg = Number(process.argv[2]);
  const count = Number.isFinite(countArg) && countArg > 0 ? Math.floor(countArg) : 3;

  const created = await seedVoteMatches(connect(databaseUrl), count);
  console.log(`Seeded ${created.length} match(es) awaiting votes:`);
  for (const match of created) {
    console.log(`  ${match.matchId} — "${match.theme}" (${match.blueUser} vs ${match.redUser})`);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runFromCommandLine().catch((error) => {
    console.error("Seeding vote matches failed.", error);
    process.exitCode = 1;
  });
}
