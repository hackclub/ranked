import { NextRequest } from "next/server";
import { getSql } from "@/db";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import type { AvatarConfig } from "@/app/lib/avatar";

export type DbUser = {
  id: string;
  email: string;
  name: string;
  slackId: string | null;
  verificationStatus: string | null;
  experience: "beginner" | "intermediate" | "expert" | null;
  elo: number;
  matchesPlayed: number;
  codingSeconds: number;
  hBucks: number;
  avatar: AvatarConfig;
};

export async function currentUser(request: NextRequest): Promise<DbUser | null> {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) return null;
  const rows = await getSql()`
    SELECT id, email, name, slack_id AS "slackId", verification_status AS "verificationStatus",
      experience, elo, matches_played AS "matchesPlayed", coding_seconds AS "codingSeconds",
      h_bucks AS "hBucks", avatar
    FROM users WHERE id = ${session.user.id} LIMIT 1
  `;
  return (rows[0] as DbUser | undefined) ?? null;
}
