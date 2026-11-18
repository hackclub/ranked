import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { logAudit } from "@/app/lib/audit";
import { updateSubmissionDescription } from "@/app/lib/airtable";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import { getSql } from "@/db";

// Prepended to a publication's description the first time it's reported for
// AI-generated code — checked for on repeat reports so the same build never
// gets flagged twice over. No new Airtable field: this rides in the existing
// Description column so a reviewer sees it right on the submission itself,
// whether or not it had already been sent to Airtable when the report came in.
const AI_REPORT_FLAG = "[REPORTED: possible AI-generated code] ";

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    type?: unknown;
    targetId?: unknown;
    details?: unknown;
  } | null;
  const type = body?.type;
  const targetId = typeof body?.targetId === "string" ? body.targetId : "";
  const details = body?.details;
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

  // One report of each type per player per match. A repeat is acknowledged
  // the same way as the original so the reporter isn't left wondering, but it
  // doesn't add a second row for a reviewer to wade through.
  const alreadyFiled = await getSql()`SELECT 1 FROM reports
    WHERE match_id=${matchId} AND reporter_id=${user.id} AND target_id=${targetId} AND type=${type}::report_type LIMIT 1`;
  if (alreadyFiled.length) return NextResponse.json({ ok: true, duplicate: true });
  if (await rateLimited(`report:${user.id}`, 5, 600)) {
    return tooManyRequests("You've filed several reports in a short time. Try again in a few minutes.");
  }

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

  if (type === "ai") {
    const publicationRows = await getSql()`SELECT id, description, airtable_record_id AS "airtableRecordId"
      FROM publications WHERE match_id=${matchId} AND published_by=${targetId}`;
    const publication = publicationRows[0] as
      | { id: string; description: string | null; airtableRecordId: string | null }
      | undefined;
    // No publication yet (they haven't published this build) — nothing to
    // flag; the report itself is still filed and audited above regardless.
    if (publication && !publication.description?.startsWith(AI_REPORT_FLAG)) {
      const flaggedDescription = `${AI_REPORT_FLAG}${publication.description ?? ""}`;
      await getSql()`UPDATE publications SET description=${flaggedDescription} WHERE id=${publication.id}`;
      let airtableSynced = false;
      let airtableError: string | undefined;
      if (publication.airtableRecordId) {
        try {
          await updateSubmissionDescription(publication.airtableRecordId, flaggedDescription);
          airtableSynced = true;
        } catch (error) {
          // The report and the local flag are already saved regardless — an
          // Airtable-side hiccup here shouldn't fail (or roll back) the
          // report a player just filed. Logged below either way so this
          // never silently fails to reach a reviewer.
          airtableError = error instanceof Error ? error.message : "Airtable update failed.";
          console.error("Could not flag Airtable submission for AI report", error);
        }
      }
      await logAudit({
        actor: null,
        action: "report.ai_flag.applied",
        summary: publication.airtableRecordId
          ? `${targetRow[0].name}'s submission was flagged as possible AI-generated code${airtableSynced ? " in Airtable" : " (Airtable sync failed — flagged locally only)"}`
          : `${targetRow[0].name}'s build was flagged as possible AI-generated code (not yet submitted to Airtable)`,
        targetType: "publication",
        targetId: publication.id,
        metadata: {
          matchId,
          reportId,
          reportedUserId: targetId,
          airtableRecordId: publication.airtableRecordId,
          airtableSynced,
          airtableError,
        },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
