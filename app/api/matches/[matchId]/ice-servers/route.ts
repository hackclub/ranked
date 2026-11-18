import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { recordingHealth } from "@/app/lib/recordings";
import { iceConfiguration } from "@/app/lib/turn";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

// Hands a match participant the ICE servers for the call, including TURN
// credentials when a TURN server is configured. Credentials are minted here,
// per request, so none are ever built into the client bundle.
export async function GET(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const { matchId } = await context.params;
  // TURN credentials are relay capacity someone pays for, so they are only
  // handed out while the match's call is actually open.
  const recording = await recordingHealth(matchId, user.id);
  if (!recording.participant || !recording.live) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  return NextResponse.json(await iceConfiguration(user.id), { headers: NO_STORE });
}
