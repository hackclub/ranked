import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { decryptCredential } from "@/app/lib/credential";
import { revokeHackatimeToken } from "@/app/lib/hackatime";
import { getSql } from "@/db";

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await getSql()`
    SELECT access_token_encrypted AS "encryptedToken"
    FROM hackatime_connections WHERE user_id = ${user.id} LIMIT 1
  `;
  const encryptedToken = rows[0]?.encryptedToken as string | undefined;
  if (encryptedToken) {
    try {
      await revokeHackatimeToken(await decryptCredential(encryptedToken));
    } catch (error) {
      console.error(error);
    }
  }
  await getSql()`DELETE FROM matchmaking_queue WHERE user_id = ${user.id}`;
  await getSql()`DELETE FROM hackatime_connections WHERE user_id = ${user.id}`;
  return NextResponse.json({ ok: true });
}
