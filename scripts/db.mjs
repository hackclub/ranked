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

export function connect(databaseUrl) {
  if (isLocalDatabaseUrl(databaseUrl)) {
    neonConfig.fetchEndpoint = (host) => `http://${host}:4444/sql`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.poolQueryViaFetch = true;
  }
  return neon(databaseUrl);
}

/**
 * Loads .env.local and returns DATABASE_URL with a printable `host/dbname`
 * target, or null (with exitCode set) after explaining why it can't be used.
 */
export function databaseFromEnv() {
  config({ path: ".env.local" });

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not configured. Set it in .env.local or the environment.",
    );
    process.exitCode = 1;
    return null;
  }

  try {
    const parsed = new URL(url);
    return { url, target: `${parsed.hostname}${parsed.pathname}` };
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exitCode = 1;
    return null;
  }
}

/** True only when the command was run with `--confirm <token>`. */
export function hasConfirmation(token, npmScript, cancelledMessage) {
  const confirmIndex = process.argv.indexOf("--confirm");
  if (confirmIndex !== -1 && process.argv[confirmIndex + 1] === token) {
    return true;
  }
  console.error(cancelledMessage);
  console.error(`Run: npm run ${npmScript} -- --confirm ${token}`);
  process.exitCode = 1;
  return false;
}

/** Runs `main` only when `moduleUrl` is the script node was started with. */
export function runIfInvokedDirectly(moduleUrl, main, failureMessage) {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) {
    return;
  }
  main().catch((error) => {
    console.error(failureMessage, error);
    process.exitCode = 1;
  });
}
