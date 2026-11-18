import { Liveblocks } from "@liveblocks/node";
import { NextRequest } from "next/server";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { getSql } from "@/db";
import { avatarAccent, normalizeAvatar, type AvatarConfig } from "@/app/lib/avatar";
import { isCrossSiteMutation } from "@/app/lib/urls";
import { recordingHealth } from "@/app/lib/recordings";
import { rateLimited } from "@/app/lib/rate-limit";

export async function POST(request: NextRequest) {
  if (isCrossSiteMutation(request)) return new Response("Invalid request origin.", { status: 403 });
  const secret = process.env.LIVEBLOCKS_SECRET_KEY;
  if (!secret) return new Response("LIVEBLOCKS_SECRET_KEY is not configured.", { status: 503 });
  const userSession = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userSession?.user) return new Response("Sign in with Hack Club first.", { status: 401 });
  const payload = await request.json().catch(() => null) as { room?: unknown } | null;
  const room = typeof payload?.room === "string" ? payload.room : undefined;
  // A match has one call room shared by every player and one code room per
  // team. The team suffix is required on a code room and not allowed on a
  // call room, so there is exactly one valid room name of each kind.
  const match = room?.match(/^ranked:(?:call:([^:]+)|code:([^:]+):(blue|red))$/);
  if (!match) return new Response("Invalid room.", { status: 403 });
  const kind = match[1] ? "call" : "code";
  const matchId = (match[1] ?? match[2])!;
  const requestedTeam = match[3];
  // 429 is retried by the Liveblocks client with backoff, which is the right
  // outcome for a player who briefly trips this during reconnects.
  if (await rateLimited(`liveblocks-auth:${userSession.user.id}`, 60, 60)) {
    return new Response("Too many room requests. Try again in a moment.", { status: 429 });
  }
  const players = await getSql()`SELECT mp.team,COALESCE(u.slack_username, split_part(u.name, ' ', 1)) AS name,u.avatar FROM match_players mp JOIN users u ON u.id=mp.user_id
    WHERE mp.match_id=${matchId} AND mp.user_id=${userSession.user.id}`;
  const player = players[0] as { team: "blue" | "red"; name: string; avatar: AvatarConfig } | undefined;
  if (!player || (kind === "code" && requestedTeam !== player.team)) return new Response("You are not a member of this room.", { status: 403 });
  if (kind === "call") {
    // The call exists only for the match's timed window, which is also the
    // only time it is recorded. Once the timer ends (or the match is decided)
    // no new call tokens are issued.
    const recording = await recordingHealth(matchId, userSession.user.id);
    if (!recording.live) return new Response("This match's call has ended.", { status: 403 });
    // 503 rather than 403: the Liveblocks client gives up for good on a 403
    // but retries anything else, so a player whose recording recovers is let
    // back into the call without reloading.
    if (!recording.ok) return new Response("Your safety recording is not reaching storage yet.", { status: 503 });
  }
  const liveblocks = new Liveblocks({ secret });
  const session = liveblocks.prepareSession(userSession.user.id, {
    userInfo: {
      // Only what other players in the room are meant to see. Everything here
      // is readable by every client in the room, opponents included.
      name: player.name,
      color: avatarAccent(player.avatar),
      avatarConfig: normalizeAvatar(player.avatar),
      // Server-verified team membership. Clients must use this, never the
      // self-declared presence.team, to decide whose audio is team-only.
      team: player.team,
    },
  });
  session.allow(room!, ["*:write"]);
  const { body, status } = await session.authorize();
  return new Response(body, { status });
}
