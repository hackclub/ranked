import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

const DURATIONS = [10, 30, 60] as const;

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await getSql()`
    SELECT mode, duration_minutes AS "durationMinutes", COUNT(*)::int AS count
    FROM matchmaking_queue GROUP BY mode, duration_minutes
  `;
  // Cross-tabbed by (mode, duration) rather than two independent marginals —
  // the count under "10" while "solo" is selected must be solo-10s only,
  // not every 10-minute queuer across both modes.
  const counts = {
    solo: { 10: 0, 30: 0, 60: 0 },
    duo: { 10: 0, 30: 0, 60: 0 },
  };
  for (const row of rows as { mode: "solo" | "duo"; durationMinutes: number; count: number }[]) {
    if (DURATIONS.includes(row.durationMinutes as (typeof DURATIONS)[number])) {
      counts[row.mode][row.durationMinutes as (typeof DURATIONS)[number]] += row.count;
    }
  }
  return NextResponse.json({ counts });
}
