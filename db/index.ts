import { neon, neonConfig, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let cachedUrl: string | null = null;
let cachedSql: NeonQueryFunction<false, false> | null = null;
let cachedDb: NeonHttpDatabase<typeof schema> | null = null;

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured.");
  return url;
}

// Neon's HTTP driver targets Neon's own API by default. Against a local
// Postgres, route it through local-neon-http-proxy (see docker-compose.yml)
// instead, which speaks the same HTTP protocol in front of a plain database.
function isLocalDatabaseUrl(url: string) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function getSql() {
  const url = databaseUrl();
  if (!cachedSql || cachedUrl !== url) {
    cachedUrl = url;
    if (isLocalDatabaseUrl(url)) {
      neonConfig.fetchEndpoint = (host) => `http://${host}:4444/sql`;
      neonConfig.useSecureWebSocket = false;
      neonConfig.poolQueryViaFetch = true;
    }
    cachedSql = neon(url);
    cachedDb = null;
  }
  return cachedSql;
}

export function getDb() {
  cachedDb ??= drizzle(getSql(), { schema });
  return cachedDb;
}
