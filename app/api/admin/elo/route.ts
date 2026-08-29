import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { isAdmin } from "@/app/lib/admin";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

// Admin-only testing tool for quickly walking a tier's boundaries (comet
// through galaxy) without grinding out real matches — adjusts the admin's
// own ELO only, clamped so a stray click can't push it negative or absurd.
const STEP = 100;
const MIN_ELO = 0;
const MAX_ELO = 10_000;

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user || !isAdmin(user.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { direction } = (await request.json()) as { direction?: "up" | "down" };
  if (direction !== "up" && direction !== "down") {
    return NextResponse.json({ error: "Invalid direction." }, { status: 400 });
  }
  const delta = direction === "up" ? STEP : -STEP;
  const rows = await getSql()`
    UPDATE users SET elo = GREATEST(${MIN_ELO}, LEAST(${MAX_ELO}, elo + ${delta})), updated_at = NOW()
    WHERE id = ${user.id}
    RETURNING elo
  `;
  const elo = rows[0]?.elo as number | undefined;
  if (elo === undefined) return NextResponse.json({ error: "Could not adjust ELO." }, { status: 500 });
  await logAudit({
    actor: { id: user.id, name: user.name, email: user.email },
    action: "admin.elo_adjusted",
    summary: `${user.name} ${direction === "up" ? "raised" : "lowered"} their own ELO by ${STEP} (admin tool) to ${elo}`,
    targetType: "user",
    targetId: user.id,
    metadata: { direction, delta, elo },
  });
  return NextResponse.json({ elo });
}
