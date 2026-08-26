import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  PRIVATE_RECORDING_HEADERS,
  purgeExpiredRecordings,
} from "@/app/lib/recordings";

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
  return NextResponse.json(
    { ok: true, ...result },
    { headers: PRIVATE_RECORDING_HEADERS },
  );
}
