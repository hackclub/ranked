import { connect, databaseFromEnv, hasConfirmation, runIfInvokedDirectly } from "./db.mjs";

/**
 * Shipping addresses on shop orders are stored encrypted (see
 * app/lib/shipping.ts) and nothing in the app reads them back. This script is
 * how staff do:
 *
 *   npm run shop:orders
 *     Prints every physical order awaiting fulfilment with its decrypted
 *     address. The output is players' home addresses: run it only when you
 *     are about to ship, and do not paste it anywhere.
 *
 *   npm run shop:encrypt-shipping -- --confirm encrypt-shipping
 *     One-off: encrypts addresses saved before encryption existed. Safe to
 *     run more than once; rows that are already encrypted are left alone.
 *
 * Both need the same secrets the app runs with (.env.local or the
 * environment): SHIPPING_ENCRYPTION_KEY if the deployment sets one, and
 * AUTH_SESSION_SECRET.
 */

const encoder = new TextEncoder();

// Must match requireSecret() in app/lib/aes-gcm.ts.
function requireSecret(name) {
  const secret = process.env[name];
  if (!secret || secret.trim().length < 32 || /^\s*replace[-_ ]with/i.test(secret)) {
    throw new Error(`${name} must be the same 32+ character value the app runs with.`);
  }
  return secret;
}

// Must match shippingSecret()/encryptShipping() in app/lib/shipping.ts.
async function shippingKey(which) {
  const secret = requireSecret(which === "shipping" ? "SHIPPING_ENCRYPTION_KEY" : "AUTH_SESSION_SECRET");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`ranked:shop-shipping:v1:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function currentKeyName() {
  return process.env.SHIPPING_ENCRYPTION_KEY ? "shipping" : "session";
}

function isEncrypted(shipping) {
  return Boolean(shipping && shipping.v === 1 && typeof shipping.enc === "string");
}

export async function encryptShipping(shipping) {
  const key = currentKeyName();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await shippingKey(key),
    encoder.encode(JSON.stringify(shipping)),
  );
  return {
    v: 1,
    key,
    enc: `${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`,
  };
}

export async function decryptShipping(stored) {
  // Rows from before encryption are the address itself.
  if (!isEncrypted(stored)) return stored;
  const [iv, encrypted] = stored.enc.split(".");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
    await shippingKey(stored.key === "shipping" ? "shipping" : "session"),
    Buffer.from(encrypted, "base64url"),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function encryptLegacyShipping(sql) {
  const rows = await sql`SELECT id, shipping FROM shop_orders
    WHERE shipping IS NOT NULL AND NOT (shipping ? 'enc')`;
  for (const row of rows) {
    const stored = JSON.stringify(await encryptShipping(row.shipping));
    // The NOT (shipping ? 'enc') guard keeps a concurrent run from encrypting
    // an already-encrypted value a second time.
    await sql`UPDATE shop_orders SET shipping=${stored}::jsonb, updated_at=NOW()
      WHERE id=${row.id} AND NOT (shipping ? 'enc')`;
  }
  return { encryptedCount: rows.length };
}

async function printPendingOrders(sql) {
  const rows = await sql`SELECT o.id, o.item_name AS "itemName", o.status, o.created_at AS "createdAt",
      o.shipping, u.name AS "userName", u.email
    FROM shop_orders o JOIN users u ON u.id=o.user_id
    WHERE o.shipping IS NOT NULL AND o.status IN ('pending','approved')
    ORDER BY o.created_at`;
  if (!rows.length) {
    console.log("No physical orders are waiting to ship.");
    return;
  }
  for (const row of rows) {
    let address;
    try {
      address = await decryptShipping(row.shipping);
    } catch {
      address = null;
    }
    console.log(`\n${row.itemName} — ${row.status} — ordered ${new Date(row.createdAt).toISOString().slice(0, 10)}`);
    console.log(`  order ${row.id}`);
    console.log(`  account: ${row.userName} <${row.email}>`);
    if (!address) {
      console.log("  address: could not be decrypted with the configured secrets");
      continue;
    }
    for (const line of [
      address.name,
      address.address1,
      address.address2,
      [address.city, address.region, address.postalCode].filter(Boolean).join(", "),
      address.country,
    ]) {
      if (line) console.log(`  ${line}`);
    }
  }
}

async function runFromCommandLine() {
  const database = databaseFromEnv();
  if (!database) return;
  const sql = connect(database.url);

  if (process.argv.includes("--encrypt-legacy")) {
    if (
      !hasConfirmation(
        "encrypt-shipping",
        "shop:encrypt-shipping",
        `This rewrites stored shipping addresses on ${database.target}. Cancelled.`,
      )
    ) {
      return;
    }
    const result = await encryptLegacyShipping(sql);
    console.log(`Done. Encrypted ${result.encryptedCount} order address(es) on ${database.target}.`);
    return;
  }

  await printPendingOrders(sql);
}

runIfInvokedDirectly(import.meta.url, runFromCommandLine, "Shop shipping command failed.");
