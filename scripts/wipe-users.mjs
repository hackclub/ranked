import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";

config({ path: ".env.local" });

const confirmation = "WIPE_ALL_USER_DATA";
const confirmIndex = process.argv.indexOf("--confirm");
const confirmed =
  confirmIndex !== -1 && process.argv[confirmIndex + 1] === confirmation;

if (!confirmed) {
  console.error("Database wipe cancelled.");
  console.error(
    `Run: npm run db:wipe-users -- --confirm ${confirmation}`,
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not configured. Set it in .env.local or the environment.",
  );
  process.exit(1);
}

let target;
try {
  const parsed = new URL(databaseUrl);
  target = `${parsed.hostname}${parsed.pathname}`;
} catch {
  console.error("DATABASE_URL is not a valid URL.");
  process.exit(1);
}

const sql = neon(databaseUrl);

console.log(`Wiping all Ranked user data from ${target}...`);

const [before] = await sql`
  SELECT
    (SELECT COUNT(*)::int FROM users) AS users,
    (SELECT COUNT(*)::int FROM matches) AS matches,
    (SELECT COUNT(*)::int FROM votes) AS votes,
    (SELECT COUNT(*)::int FROM publications) AS publications,
    (SELECT COUNT(*)::int FROM shop_orders) AS shop_orders
`;

await sql`
  TRUNCATE TABLE
    daily_challenge_progress,
    elo_transactions,
    friendships,
    match_snapshots,
    publications,
    shop_orders,
    votes,
    matchmaking_queue,
    match_players,
    matches,
    users
  RESTART IDENTITY CASCADE
`;

const [after] = await sql`
  SELECT
    (SELECT COUNT(*)::int FROM users) AS users,
    (SELECT COUNT(*)::int FROM matches) AS matches,
    (SELECT COUNT(*)::int FROM votes) AS votes,
    (SELECT COUNT(*)::int FROM publications) AS publications,
    (SELECT COUNT(*)::int FROM shop_orders) AS shop_orders
`;

console.log("Database wipe complete.");
console.log("Before:", before);
console.log("After:", after);
