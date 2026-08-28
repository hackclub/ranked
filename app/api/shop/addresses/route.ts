import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import {
  addressLabel,
  completeSubmissionAddresses,
  completeSubmissionProfile,
  getHackClubProfile,
} from "@/app/lib/hack-club-profile";

// Backs the shop's shipping-address picker — unlike match publishing (which
// always ships to whichever address HCA marked primary), a physical prize
// redemption is a deliberate one-off choice, so the player picks from
// whatever complete addresses their Hack Club Auth account actually has.
export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const profile = await getHackClubProfile(user.id);
  const addresses = completeSubmissionAddresses(profile).map((address) => ({
    id: address.id,
    label: addressLabel(address),
    primary: address.primary === true,
  }));
  return NextResponse.json({
    ready: completeSubmissionProfile(profile),
    addresses,
  });
}
