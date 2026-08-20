import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { isAdmin } from "@/app/lib/admin";
import { getSql } from "@/db";

const PAGE_SIZE = 20;

// Manually-logged security/moderation events (audit_log) are merged with the
// ELO ledger (elo_transactions) — that table is already an immutable,
// per-match audit trail, so it is read here rather than duplicated into
// audit_log at write time. Grouping by match+reason turns the two per-player
// rows a settled match writes into one legible feed entry.
const FEED_CTE = `
  WITH combined AS (
    SELECT id, created_at AS "createdAt", action, summary, actor_name AS "actorName",
      actor_email AS "actorEmail", target_type AS "targetType", target_id AS "targetId"
    FROM audit_log
    UNION ALL
    SELECT
      'elo:' || e.match_id || ':' || e.reason AS id,
      MAX(e.created_at) AS "createdAt",
      'match.elo_settled' AS action,
      'Match "' || m.theme || '" settled (' || e.reason || '): ' ||
        string_agg(u.name || ' ' || (CASE WHEN e.delta >= 0 THEN '+' ELSE '' END) || e.delta::text || ' elo', ', ' ORDER BY u.name) AS summary,
      NULL AS "actorName",
      NULL AS "actorEmail",
      'match' AS "targetType",
      e.match_id AS "targetId"
    FROM elo_transactions e
    JOIN matches m ON m.id = e.match_id
    JOIN users u ON u.id = e.user_id
    GROUP BY e.match_id, e.reason, m.theme
  )
`;

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user || !isAdmin(user.email)) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const sql = getSql();
  const requestedPage = Number(request.nextUrl.searchParams.get("page"));
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const [countRows, entries] = await Promise.all([
    sql.query(`${FEED_CTE} SELECT COUNT(*)::int AS count FROM combined`, []),
    sql.query(
      `${FEED_CTE} SELECT * FROM combined ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset],
    ),
  ]);

  const totalEntries = Number((countRows[0] as { count: number } | undefined)?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));

  return NextResponse.json({
    page: Math.min(page, totalPages),
    pageSize: PAGE_SIZE,
    totalEntries,
    totalPages,
    entries,
  });
}
