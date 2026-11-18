import { NextResponse } from "next/server";
import { getSql } from "@/db";

// Fixed-window counters kept in Postgres. The app runs as serverless
// functions, so a counter held in memory would be per-instance and reset on
// every cold start; one row per key is the only state every instance shares.
//
// `key` names both the rule and who it applies to ("report:<userId>"). Returns
// true when this call takes the caller over `limit` within the window.
//
// Fails open: these limits are a second line of defence behind authentication
// and each route's own checks, so a database hiccup here (or the table not
// having been migrated yet) must not take the route down with it.
export async function rateLimited(key: string, limit: number, windowSeconds: number) {
  try {
    const rows = await getSql()`
      INSERT INTO rate_limits (key,window_start,count) VALUES (${key},NOW(),1)
      ON CONFLICT (key) DO UPDATE SET
        count=CASE WHEN rate_limits.window_start<=NOW()-(${windowSeconds}||' seconds')::interval
          THEN 1 ELSE rate_limits.count+1 END,
        window_start=CASE WHEN rate_limits.window_start<=NOW()-(${windowSeconds}||' seconds')::interval
          THEN NOW() ELSE rate_limits.window_start END
      RETURNING count
    `;
    return Number(rows[0]?.count ?? 0) > limit;
  } catch (error) {
    console.error("Rate limit check failed", error);
    return false;
  }
}

export function tooManyRequests(
  message = "You're doing that too often. Try again in a little while.",
  headers?: Record<string, string>,
) {
  return NextResponse.json({ error: message }, { status: 429, headers });
}

// Counters are only meaningful inside their window; the daily cron clears the
// ones that have long since expired so the table stays small.
export async function purgeExpiredRateLimits() {
  await getSql()`DELETE FROM rate_limits WHERE window_start<NOW()-INTERVAL '1 day'`;
}
