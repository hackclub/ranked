// Resolves a Hack Club Auth slack_id into the name Slack actually displays for
// that person (profile.display_name, falling back to real_name if they never
// set one) — not the legacy `name`/username field, which is an auto-generated
// handle nobody chose and isn't shown anywhere in Slack's own UI anymore.
// Best-effort only: callers decide what "missing" means for their flow (the
// Hack Club Auth callback falls back to leaving it null so onboarding can
// prompt the player to set one themselves).
export async function fetchSlackUsername(slackId: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return null;
  try {
    const response = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(slackId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return null;
    const result = (await response.json()) as {
      ok: boolean;
      user?: {
        deleted?: boolean;
        profile?: { display_name?: string; real_name?: string };
      };
    };
    if (!result.ok || !result.user || result.user.deleted) return null;
    const username =
      result.user.profile?.display_name?.trim() ||
      result.user.profile?.real_name?.trim();
    return username ? username : null;
  } catch {
    return null;
  }
}
