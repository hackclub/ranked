import { connect, databaseFromEnv, hasConfirmation } from "./db.mjs";

if (!hasConfirmation("WIPE_ALL_USER_DATA", "db:wipe-users", "Database wipe cancelled.")) {
  process.exit();
}

const database = databaseFromEnv();
if (!database) process.exit();

const sql = connect(database.url);

console.log(`Wiping all Ranked user data from ${database.target}...`);

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
