import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // This returns the whole member list, so it is the one read worth metering.
  if (await rateLimited(`friend-directory:${user.id}`, 30, 60)) return tooManyRequests();
  const members = await getSql()`SELECT id, slack_username AS "slackUsername" FROM users
    WHERE id<>${user.id} AND slack_username IS NOT NULL ORDER BY slack_username`;
  return NextResponse.json({ members });
}
