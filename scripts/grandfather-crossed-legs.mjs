import { pathToFileURL } from "node:url";
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
 * Limbs value 3 ("Crossed Legs") moved from the free starter pool into a
 * 50 H-buck Shop item (see PAYWALLED_STARTER_VALUES in app/lib/avatar.ts).
 * Anyone who already has it equipped needs a free (cost 0) shop_orders row
 * backdating their ownership, or PATCH /api/profile will start rejecting
 * their next Wardrobe save for a look they never had to buy.
 *
 * Idempotent — safe to run more than once, it only inserts for users who
 * don't already own the item.
 */
export async function grandfatherCrossedLegs(sql) {
  const granted = await sql`
    INSERT INTO shop_orders (id, user_id, item_id, item_name, cost, status)
    SELECT gen_random_uuid()::text, u.id, 'avatar_limbs_crossed', 'Crossed Legs', 0, 'approved'
    FROM users u
    WHERE u.avatar->>'limbs' = '3'
      AND NOT EXISTS (
        SELECT 1 FROM shop_orders o
        WHERE o.user_id = u.id AND o.item_id = 'avatar_limbs_crossed'
      )
    RETURNING user_id
  `;
  return { grantedCount: granted.length };
}

async function runFromCommandLine() {
  config({ path: ".env.local" });

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

  console.log(`Grandfathering existing "Crossed Legs" users on ${target}...`);
  const result = await grandfatherCrossedLegs(connect(databaseUrl));
  console.log(`Done. Granted ownership to ${result.grantedCount} user(s).`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runFromCommandLine().catch((error) => {
    console.error("Grandfathering failed.", error);
    process.exitCode = 1;
  });
}
