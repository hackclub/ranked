import { connect, databaseFromEnv, runIfInvokedDirectly } from "./db.mjs";

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
  const database = databaseFromEnv();
  if (!database) return;

  console.log(`Grandfathering existing "Crossed Legs" users on ${database.target}...`);
  const result = await grandfatherCrossedLegs(connect(database.url));
  console.log(`Done. Granted ownership to ${result.grantedCount} user(s).`);
}

runIfInvokedDirectly(import.meta.url, runFromCommandLine, "Grandfathering failed.");
