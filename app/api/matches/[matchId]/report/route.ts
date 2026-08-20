import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const { type, targetId, details } = (await request.json()) as {
    type?: string;
    targetId?: string;
    details?: string;
  };
  if (type !== "misconduct" && type !== "ai") return NextResponse.json({ error: "Invalid report type." }, { status: 400 });
  if (!targetId || targetId === user.id) return NextResponse.json({ error: "Choose who you're reporting." }, { status: 400 });
  const trimmedDetails = typeof details === "string" ? details.trim().slice(0, 1000) : "";

  const [reporterRow, targetRow] = await Promise.all([
    getSql()`SELECT 1 FROM match_players WHERE match_id=${matchId} AND user_id=${user.id}`,
    getSql()`SELECT name FROM users WHERE id=${targetId} AND EXISTS (
      SELECT 1 FROM match_players WHERE match_id=${matchId} AND user_id=${targetId}
    )`,
  ]);
  if (!reporterRow.length) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
  if (!targetRow.length) return NextResponse.json({ error: "That player isn't in this match." }, { status: 400 });

  const reportId = crypto.randomUUID();
  await getSql()`INSERT INTO reports (id, match_id, reporter_id, target_id, type, details)
    VALUES (${reportId},${matchId},${user.id},${targetId},${type}::report_type,${trimmedDetails || null})`;
  await logAudit({
    actor: { id: user.id, name: user.name, email: user.email },
    action: "report.created",
    summary: `${user.name} filed a ${type === "ai" ? "possible AI-generated code" : "misconduct"} report against ${targetRow[0].name}`,
    targetType: "report",
    targetId: reportId,
    metadata: { matchId, reportedUserId: targetId, type },
  });
  return NextResponse.json({ ok: true });
}
