import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
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

export function getSql() {
  const url = databaseUrl();
  if (!cachedSql || cachedUrl !== url) {
    cachedUrl = url;
    cachedSql = neon(url);
    cachedDb = null;
  }
  return cachedSql;
}

export function getDb() {
  cachedDb ??= drizzle(getSql(), { schema });
  return cachedDb;
}
