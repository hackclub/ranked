import { randomUUID } from "node:crypto";
import { connect, databaseFromEnv, runIfInvokedDirectly } from "./db.mjs";

/**
 * Creates fake "finished, awaiting votes" matches so the /vote screen has
 * something to show locally without actually playing a match end-to-end.
 * Reuses the seed-voter-* bot accounts as the two "players" and points both
 * builds at the static HTML/CSS sites in public/seed-builds, served by the
 * app itself at APP_BASE_URL. The theme is one generateMatchTheme() can
 * actually produce (app/lib/match-lifecycle.ts), and both builds fit it.
 */
const THEME = "An online shop for unemployed wizards";

const BUILDS = [
  {
    description: "wizard shop for wizards that got fired",
    pagePath: "/seed-builds/wizard-shop-a/index.html",
    repositoryUrl: "https://github.com/hackclub/ranked-seed-build-a",
    githubRepo: "ranked-seed-build-a",
  },
  {
    description: "its a store for wizards who lost there jobs. u can buy wands, spellbooks and crystal balls. click buy to buy stuff",
    pagePath: "/seed-builds/wizard-shop-b/index.html",
    repositoryUrl: "https://github.com/hackclub/ranked-seed-build-b",
    githubRepo: "ranked-seed-build-b",
  },
];

export async function seedVoteMatches(sql, count = 1) {
  const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const bots = await sql`SELECT id FROM users WHERE id LIKE 'seed-voter-%' ORDER BY id`;
  if (bots.length < 2) {
    throw new Error(
      "Need at least 2 seed-voter-* users in the database — none found (or fewer than 2).",
    );
  }

  const created = [];
  for (let i = 0; i < count; i++) {
    const matchId = randomUUID();
    const theme = THEME;
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
          (${randomUUID()}, ${matchId}, 'blue', ${buildA.repositoryUrl}, ${baseUrl + buildA.pagePath}, ${buildA.githubRepo}, ${buildA.description}, ${blueUser}),
          (${randomUUID()}, ${matchId}, 'red', ${buildB.repositoryUrl}, ${baseUrl + buildB.pagePath}, ${buildB.githubRepo}, ${buildB.description}, ${redUser})`,
    ]);
    created.push({ matchId, theme, blueUser, redUser });
  }
  return created;
}

async function runFromCommandLine() {
  const database = databaseFromEnv();
  if (!database) return;

  const countArg = Number(process.argv[2]);
  const count = Number.isFinite(countArg) && countArg > 0 ? Math.floor(countArg) : 1;

  const created = await seedVoteMatches(connect(database.url), count);
  console.log(`Seeded ${created.length} match(es) awaiting votes:`);
  for (const match of created) {
    console.log(`  ${match.matchId} — "${match.theme}" (${match.blueUser} vs ${match.redUser})`);
  }
}

runIfInvokedDirectly(import.meta.url, runFromCommandLine, "Seeding vote matches failed.");
