import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { decryptCredential } from "@/app/lib/credential";
import { sendHackatimeHeartbeat } from "@/app/lib/hackatime";
import { getSql } from "@/db";

const FILES = {
  "index.html": "HTML",
  "styles.css": "CSS",
  "script.js": "JavaScript",
} as const;

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number)
    ? Math.max(1, Math.min(maximum, number))
    : fallback;
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    matchId?: string;
    file?: string;
    lines?: number;
    line?: number;
    cursorPosition?: number;
  };
  const file = body.file as keyof typeof FILES;
  if (!body.matchId || !Object.hasOwn(FILES, file)) {
    return NextResponse.json({ error: "Invalid heartbeat." }, { status: 400 });
  }

  const matchRows = await getSql()`
    SELECT mp.team
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    WHERE mp.match_id = ${body.matchId} AND mp.user_id = ${user.id}
      AND m.status = 'active' AND m.ends_at > NOW()
    LIMIT 1
  `;
  const team = matchRows[0]?.team as "blue" | "red" | undefined;
  if (!team) {
    return NextResponse.json(
      { error: "Hackatime only records during an active match." },
      { status: 403 },
    );
  }

  const connectionRows = await getSql()`
    UPDATE hackatime_connections
    SET last_heartbeat_at = NOW(), updated_at = NOW()
    WHERE user_id = ${user.id}
      AND (last_heartbeat_at IS NULL OR last_heartbeat_at < NOW() - INTERVAL '25 seconds')
    RETURNING api_key_encrypted AS "encryptedApiKey"
  `;
  const encryptedApiKey = connectionRows[0]?.encryptedApiKey as
    | string
    | undefined;
  if (!encryptedApiKey) {
    return NextResponse.json({ ok: true, throttled: true }, { status: 202 });
  }

  try {
    await sendHackatimeHeartbeat(await decryptCredential(encryptedApiKey), {
      entity: `ranked/${body.matchId}/${file}`,
      type: "file",
      time: Date.now() / 1000,
      project: "hack-club-ranked",
      branch: `match-${body.matchId.slice(0, 8)}-${team}`,
      language: FILES[file],
      is_write: true,
      lineno: boundedInteger(body.line, 1, 100_000),
      cursorpos: boundedInteger(body.cursorPosition, 1, 10_000_000),
      lines: boundedInteger(body.lines, 1, 100_000),
      category: "coding",
      editor: "Monaco",
      machine: "Hack Club Ranked Web IDE",
      operating_system: "Web",
      user_agent: "hack-club-ranked/1.0 monaco-web",
    });
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number(error.status)
        : 502;
    if (status === 401) {
      await getSql()`DELETE FROM matchmaking_queue WHERE user_id = ${user.id}`;
      await getSql()`DELETE FROM hackatime_connections WHERE user_id = ${user.id}`;
      return NextResponse.json(
        { error: "Reconnect Hackatime to keep recording.", code: "hackatime_reconnect" },
        { status: 401 },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Hackatime heartbeat could not be recorded." },
      { status: 502 },
    );
  }
}
