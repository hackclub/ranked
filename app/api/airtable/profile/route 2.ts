import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import {
  completeSubmissionAddress,
  completeSubmissionProfile,
  getHackClubProfile,
  publicAddressLabel,
} from "@/app/lib/hack-club-profile";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Sign in with Hack Club first." }, { status: 401 });
  }
  const profile = await getHackClubProfile(user.id);
  return NextResponse.json({
    ready: completeSubmissionProfile(profile),
    addresses: (profile?.addresses ?? [])
      .filter((address) => profile && completeSubmissionAddress(profile, address))
      .map((address) => ({
        id: address.id,
        label: publicAddressLabel(address),
        primary: address.primary === true,
      })),
  });
}
