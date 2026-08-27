import type { NextRequest } from "next/server";
import { currentUser, type DbUser } from "@/app/lib/current-user";
import { isRecordingReviewer } from "@/app/lib/recording-policy";

export async function recordingReviewer(
  request: NextRequest,
): Promise<DbUser | null> {
  const user = await currentUser(request);
  return user && isRecordingReviewer(user.email) ? user : null;
}
