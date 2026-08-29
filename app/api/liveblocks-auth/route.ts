import { Liveblocks } from "@liveblocks/node";
import { NextRequest } from "next/server";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { getSql } from "@/db";
import { avatarAccent, normalizeAvatar, type AvatarConfig } from "@/app/lib/avatar";

export async function POST(request: NextRequest) {
  const secret = process.env.LIVEBLOCKS_SECRET_KEY;
  if (!secret) return new Response("LIVEBLOCKS_SECRET_KEY is not configured.", { status: 503 });
  const userSession = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userSession?.user) return new Response("Sign in with Hack Club first.", { status: 401 });
  const { room } = await request.json() as { room?: string };
  const match = room?.match(/^ranked:(call|code):([^:]+)(?::(blue|red))?$/);
  if (!match) return new Response("Invalid room.", { status: 403 });
  const kind = match[1]!;
  const matchId = match[2]!;
  const requestedTeam = match[3];
  const players = await getSql()`SELECT mp.team,COALESCE(u.slack_username, u.name) AS name,u.slack_id AS "slackId",u.avatar FROM match_players mp JOIN users u ON u.id=mp.user_id
    WHERE mp.match_id=${matchId} AND mp.user_id=${userSession.user.id}`;
  const player = players[0] as { team: "blue" | "red"; name: string; slackId: string | null; avatar: AvatarConfig } | undefined;
  if (!player || (kind === "code" && requestedTeam !== player.team)) return new Response("You are not a member of this room.", { status: 403 });
  const liveblocks = new Liveblocks({ secret });
  const session = liveblocks.prepareSession(userSession.user.id, {
    userInfo: {
      name: player.name,
      color: avatarAccent(player.avatar),
      slackId: player.slackId ?? "",
      avatarConfig: normalizeAvatar(player.avatar),
    },
  });
  session.allow(room!, ["*:write"]);
  const { body, status } = await session.authorize();
  return new Response(body, { status });
}
