import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { completeSubmissionProfile, getHackClubProfile } from "@/app/lib/hack-club-profile";

// The client never picks an address — the submission always ships to
// whichever one HCA has marked primary (resolved server-side in the publish
// route), so all this needs to report is whether that's even possible yet.
export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Sign in with Hack Club first." }, { status: 401 });
  }
  const profile = await getHackClubProfile(user.id);
  return NextResponse.json({ ready: completeSubmissionProfile(profile) });
}
