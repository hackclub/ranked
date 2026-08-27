import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/app/lib/session";
import { isRecordingReviewer } from "@/app/lib/recording-policy";
import RecordingReviewDashboard from "./RecordingReviewDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private recording review · Ranked",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function RecordingReviewPage() {
  const session = await getSession();
  if (!isRecordingReviewer(session?.user?.email)) notFound();
  return <RecordingReviewDashboard reviewerEmail={session!.user!.email} />;
}
