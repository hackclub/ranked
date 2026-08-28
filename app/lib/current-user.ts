import { NextRequest } from "next/server";
import { getSql } from "@/db";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import type { AvatarConfig } from "@/app/lib/avatar";

export type DbUser = {
  id: string;
  email: string;
  name: string;
  slackId: string | null;
  slackUsername: string | null;
  verificationStatus: string | null;
  experience: "beginner" | "intermediate" | "expert" | null;
  elo: number;
  matchesPlayed: number;
  codingSeconds: number;
  hBucks: number;
  avatar: AvatarConfig;
  avatarUrl: string | null;
  hackatimeConnected: boolean;
  hackatimeUserId: string | null;
  hackatimeEmail: string | null;
};

export async function currentUser(request: NextRequest): Promise<DbUser | null> {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) return null;
  const rows = await getSql()`
    WITH touched AS (
      UPDATE users SET last_seen_at = NOW() WHERE id = ${session.user.id}
        AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '2 minutes')
    )
    SELECT u.id, u.email, u.name, u.slack_id AS "slackId",
      u.slack_username AS "slackUsername",
      u.verification_status AS "verificationStatus", u.experience, u.elo,
      u.matches_played AS "matchesPlayed", u.coding_seconds AS "codingSeconds",
      u.h_bucks AS "hBucks", u.avatar, u.avatar_url AS "avatarUrl",
      (hc.user_id IS NOT NULL) AS "hackatimeConnected",
      hc.hackatime_user_id AS "hackatimeUserId",
      hc.primary_email AS "hackatimeEmail"
    FROM users u
    LEFT JOIN hackatime_connections hc ON hc.user_id = u.id
    WHERE u.id = ${session.user.id} LIMIT 1
  `;
  return (rows[0] as DbUser | undefined) ?? null;
}
