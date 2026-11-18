import { NextRequest, NextResponse } from "next/server";
import { createRankedSubmission } from "@/app/lib/airtable";
import { logAudit } from "@/app/lib/audit";
import { currentUser } from "@/app/lib/current-user";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import {
  completeSubmissionAddress,
  completeSubmissionProfile,
  getHackClubProfile,
} from "@/app/lib/hack-club-profile";
import { addChallengeProgress } from "@/app/lib/progression";
import { publicPageIsLive } from "@/app/lib/safe-fetch";
import { getSql } from "@/db";

function githubUsername(repositoryUrl: string) {
  try {
    const url = new URL(repositoryUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const login = url.pathname.split("/").filter(Boolean)[0];
    return login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Sign in with Hack Club first." }, { status: 401 });
  }
  if (await rateLimited(`airtable-submit:${user.id}`, 12, 600)) return tooManyRequests();
  const formData = await request.formData();
  const publicationIdValue = formData.get("publicationId");
  const publicationId =
    typeof publicationIdValue === "string" ? publicationIdValue : undefined;
  const screenshot = formData.get("screenshot");
  if (!publicationId || !/^[0-9a-f-]{36}$/i.test(publicationId)) {
    return NextResponse.json({ error: "A publication is required." }, { status: 400 });
  }
  if (
    !(screenshot instanceof File) ||
    screenshot.type !== "image/png" ||
    screenshot.size === 0 ||
    screenshot.size > 5_000_000 ||
    !Buffer.from(await screenshot.slice(0, 8).arrayBuffer()).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return NextResponse.json(
      { error: "A valid PNG screenshot under 5 MB is required." },
      { status: 400 },
    );
  }

  const rows = await getSql()`
    SELECT p.id, p.repository_url AS "repositoryUrl", p.pages_url AS "pagesUrl",
      p.description, p.hca_address_id AS "addressId", p.airtable_status AS "airtableStatus",
      p.airtable_record_id AS "airtableRecordId", m.duration_minutes AS "durationMinutes"
    FROM publications p JOIN matches m ON m.id=p.match_id
    WHERE p.id=${publicationId} AND p.published_by=${user.id} LIMIT 1
  `;
  const publication = rows[0] as
    | {
        id: string;
        repositoryUrl: string;
        pagesUrl: string;
        description: string | null;
        addressId: string | null;
        airtableStatus: string;
        airtableRecordId: string | null;
        durationMinutes: number;
      }
    | undefined;
  if (!publication) {
    return NextResponse.json({ error: "Publication not found." }, { status: 404 });
  }
  if (publication.airtableStatus === "submitted") {
    return NextResponse.json({ status: "submitted", recordId: publication.airtableRecordId });
  }

  // Never submit a URL until GitHub Pages actually serves it.
  try {
    if (!(await publicPageIsLive(publication.pagesUrl))) {
      return NextResponse.json({ status: "deploying" }, { status: 202 });
    }
  } catch {
    return NextResponse.json({ status: "deploying" }, { status: 202 });
  }

  const profile = await getHackClubProfile(user.id);
  const address = profile?.addresses.find((item) => item.id === publication.addressId);
  const login = githubUsername(publication.repositoryUrl);
  if (
    !completeSubmissionProfile(profile) ||
    !profile?.birthday ||
    !address ||
    !completeSubmissionAddress(profile, address) ||
    !login
  ) {
    return NextResponse.json(
      { error: "Reconnect Hack Club Auth and select a valid address." },
      { status: 409 },
    );
  }

  const claimed = await getSql()`
    UPDATE publications SET airtable_status='submitting', airtable_error=NULL,
      airtable_last_attempt_at=NOW()
    WHERE id=${publication.id} AND (
      airtable_status IN ('pending','error') OR
      (airtable_status='submitting' AND airtable_last_attempt_at < NOW()-INTERVAL '2 minutes')
    ) RETURNING id
  `;
  if (!claimed.length) {
    return NextResponse.json({ status: "submitting" }, { status: 202 });
  }

  try {
    const recordId = await createRankedSubmission({
      codeUrl: publication.repositoryUrl,
      playableUrl: publication.pagesUrl,
      description: publication.description ?? "Hack Club Ranked website",
      githubUsername: login,
      firstName: address.first_name ?? profile.firstName,
      lastName: address.last_name ?? profile.lastName,
      email: profile.email,
      birthday: profile.birthday,
      address,
      durationMinutes: publication.durationMinutes,
      screenshot,
    });
    await getSql()`UPDATE publications SET airtable_status='submitted',
      airtable_record_id=${recordId}, airtable_error=NULL, airtable_submitted_at=NOW()
      WHERE id=${publication.id}`;
    await addChallengeProgress(user.id, "play_matches", 1);
    await logAudit({
      actor: { id: user.id, name: user.name, email: user.email },
      action: "airtable.submission.upserted",
      summary: `${user.name}'s build was submitted to Airtable (record ${recordId})`,
      targetType: "publication",
      targetId: publication.id,
      metadata: { recordId, codeUrl: publication.repositoryUrl, playableUrl: publication.pagesUrl },
    });
    return NextResponse.json({ status: "submitted", recordId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Airtable submission failed.";
    console.error(message);
    await getSql()`UPDATE publications SET airtable_status='error',
      airtable_error=${message.slice(0, 500)} WHERE id=${publication.id}`;
    await logAudit({
      actor: { id: user.id, name: user.name, email: user.email },
      action: "airtable.submission.failed",
      summary: `${user.name}'s Airtable submission failed: ${message}`,
      targetType: "publication",
      targetId: publication.id,
      metadata: { error: message, codeUrl: publication.repositoryUrl },
    });
    return NextResponse.json(
      { error: "Your build is live, but Airtable submission needs a retry." },
      { status: 502 },
    );
  }
}
