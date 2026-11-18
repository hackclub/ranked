import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  PRIVATE_RECORDING_HEADERS,
  purgeExpiredRecordings,
} from "@/app/lib/recordings";
import { closeAbandonedMatches } from "@/app/lib/match-lifecycle";
import { purgeExpiredRateLimits } from "@/app/lib/rate-limit";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  const authorized = Boolean(
    secret &&
      secret.length >= 32 &&
      supplied &&
      supplied.length === secret.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(secret)),
  );
  if (
    !authorized
  ) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: PRIVATE_RECORDING_HEADERS },
    );
  }
  const result = await purgeExpiredRecordings(500);
  // Same daily tick also closes out matches nobody finished. A failure here
  // must not turn the retention run into an error, so it's reported, not thrown.
  let matches: Awaited<ReturnType<typeof closeAbandonedMatches>> | { error: true };
  try {
    matches = await closeAbandonedMatches();
  } catch (error) {
    console.error("Abandoned match cleanup failed", error);
    matches = { error: true };
  }
  await purgeExpiredRateLimits().catch((error) =>
    console.error("Rate limit cleanup failed", error),
  );
  return NextResponse.json(
    { ok: true, ...result, matches },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
