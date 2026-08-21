import { addChallengeProgress } from "@/app/lib/progression";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

export type MatchTeam = "blue" | "red";
export type MatchEndReason = "forfeit" | "disconnect";

// Themes are generated, not picked from a fixed list — "music festival" gives
// nobody anything to actually build. Composing "<format> for <entity>" (with
// some entities pulling in a concrete noun) always hands players something
// buildable: a specific product for a specific audience.
const THEME_FORMATS = [
  "an online shop",
  "the personal website",
  "A landing page",
  "a social media site",
  "a wikiHow guide",
  "a recipe blog",
  "a dating app",
  "a weather site",
  "a forum",
  "a portfolio site",
  "a museum exhibit",
  "an obituary page",
  "a subscription box landing page",
  "a conspiracy theory blog",
  "a search engine",
  "a buzzfeed quiz",
  "a travel booking site",
  "a fortune-telling site",
  "a pet adoption site",
  "an app that tracks {noun}",
  "a new york times article"
];

const THEME_ENTITIES = [
  "horseless cowboys",
  "raccoons",
  "time travelers",
  "pirates",
  "unemployed wizards",
  "vampires afraid of blood",
  "ghosts stuck in a refrigerator",
  "english teachers",
  "retired superheroes",
  "musician houseplants",
  "competitive nappers",
  "underground mole people",
  "an alien who speaks in numbers",
  "a dragon with an office job",
  "a talking vending machine",
  "a cat running for mayor",
  "a medieval knight",
  "a robot",
  "an octopus who plays the drums",
  "garden gnomes",
  "a giant",
  "a company advertising {noun}",
  "a startup selling {noun}",
  "a museum about {noun}",
  "a shop that only sells {noun}",
  "a cult that worships {noun}",
  "a subscription that delivers {noun}",
  "a club for people obsessed with {noun}",
  "a scientist studying {noun}",
  "an influencer who only talks about {noun}",
  "a Hack Clubber",
  "Hack Club"
];

const THEME_NOUNS = [
  "moon water",
  "haunted socks",
  "sentient soup",
  "glow-in-the-dark gravel",
  "malicious rubber ducks",
  "artisanal trashcans",
  "electronic dance music",
  "poor ghosts",
  "invisible paint",
  "expired pickles",
  "made-up constellations",
  "airport food",
  "illegal fireworks",
  "haunted furniture",
  "mismatched socks",
  "counterfeit clouds",
  "bubblegum",
  "recycled toothpaste",
];

function pickRandom<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function generateMatchTheme(): string {
  const format = pickRandom(THEME_FORMATS);
  const entity = pickRandom(THEME_ENTITIES).replace("{noun}", () => pickRandom(THEME_NOUNS));
  const phrase = `${format} for ${entity}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export async function activeMatch(userId: string) {
  const rows = await getSql()`SELECT m.id, m.mode, m.is_test AS "isTest", m.duration_minutes AS "durationMinutes", m.theme, m.status,
      m.started_at AS "startedAt", m.ends_at AS "endsAt",
      GREATEST(0,CEIL(EXTRACT(EPOCH FROM (m.ends_at-NOW()))))::int AS "remainingSeconds",mp.team,
      (SELECT COUNT(*)::int FROM match_players WHERE match_id=m.id) AS "playerCount"
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    WHERE mp.user_id = ${userId} AND m.status='active' ORDER BY m.created_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export type MatchOutcome = {
  status: string;
  winningTeam: MatchTeam | null;
  endReason: string | null;
  forfeitedBy: string | null;
  forfeitingTeam: MatchTeam | null;
  endedAt: string | null;
  remainingSeconds: number;
};

export type DisconnectNotice = {
  userId: string;
  name: string;
  team: MatchTeam;
  expiresAt: string;
  secondsRemaining: number;
};

export async function matchOutcome(matchId: string): Promise<MatchOutcome | null> {
  const rows = await getSql()`SELECT status, winning_team AS "winningTeam", end_reason AS "endReason",
      forfeited_by AS "forfeitedBy", forfeiting_team AS "forfeitingTeam", ended_at AS "endedAt",
      GREATEST(0,CEIL(EXTRACT(EPOCH FROM (ends_at-NOW()))))::int AS "remainingSeconds"
    FROM matches WHERE id=${matchId}`;
  return (rows[0] as MatchOutcome | undefined) ?? null;
}

export async function pendingDisconnect(matchId: string): Promise<DisconnectNotice | null> {
  const rows = await getSql()`SELECT mp.user_id AS "userId",u.name,mp.team,
      COALESCE(mp.disconnect_started_at,mp.last_heartbeat_at)+INTERVAL '10 seconds' AS "expiresAt",
      GREATEST(0,CEIL(EXTRACT(EPOCH FROM (
        COALESCE(mp.disconnect_started_at,mp.last_heartbeat_at)+INTERVAL '10 seconds'-NOW()
      ))))::int AS "secondsRemaining"
    FROM match_players mp JOIN users u ON u.id=mp.user_id JOIN matches m ON m.id=mp.match_id
    WHERE mp.match_id=${matchId} AND m.status='active' AND NOW()<m.ends_at
      AND mp.presence_confirmed_at IS NOT NULL
      AND (mp.disconnect_started_at IS NOT NULL OR mp.last_heartbeat_at<NOW()-INTERVAL '4 seconds')
    ORDER BY COALESCE(mp.disconnect_started_at,mp.last_heartbeat_at),mp.joined_at
    LIMIT 1`;
  return (rows[0] as DisconnectNotice | undefined) ?? null;
}

export async function finalizeForfeit(
  matchId: string,
  losingTeam: MatchTeam,
  reason: MatchEndReason,
  forfeitedBy: string,
  skipTimeCheck = false,
) {
  const winner: MatchTeam = losingTeam === "blue" ? "red" : "blue";
  const claimed = await getSql()`UPDATE matches SET status='finalizing',winning_team=${winner}::match_team,ended_at=NOW(),
      end_reason=${reason},forfeited_by=${forfeitedBy},forfeiting_team=${losingTeam}::match_team
    WHERE id=${matchId} AND status='active' AND (${skipTimeCheck} OR NOW()<ends_at) AND (
      ${reason}='forfeit' OR EXISTS (
        SELECT 1 FROM match_players stale WHERE stale.match_id=matches.id
          AND stale.user_id=${forfeitedBy} AND stale.team=${losingTeam}::match_team
          AND stale.presence_confirmed_at IS NOT NULL
          AND COALESCE(stale.disconnect_started_at,stale.last_heartbeat_at)+INTERVAL '10 seconds'<=NOW()
      )
    )
    RETURNING id,is_test AS "isTest",theme,mode`;
  if (!claimed.length) return null;

  const forfeiter = await getSql()`SELECT name FROM users WHERE id=${forfeitedBy}`;
  await logAudit({
    actor: null,
    action: reason === "forfeit" ? "match.forfeit" : "match.disconnect",
    summary:
      reason === "forfeit"
        ? `${forfeiter[0]?.name ?? "A player"} forfeited a ${claimed[0].mode} match ("${claimed[0].theme}")`
        : `${forfeiter[0]?.name ?? "A player"} was auto-forfeited from a ${claimed[0].mode} match ("${claimed[0].theme}") after disconnecting`,
    targetType: "match",
    targetId: matchId,
    metadata: { forfeitedBy, losingTeam, isTest: claimed[0].isTest },
  });

  if (!claimed[0].isTest) {
    await getSql().transaction([
      getSql()`WITH team_averages AS (
          SELECT mp.team,AVG(u.elo)::numeric AS average_elo
          FROM match_players mp JOIN users u ON u.id=mp.user_id WHERE mp.match_id=${matchId}
          GROUP BY mp.team
        ), ratings AS (
          SELECT mp.user_id,mp.match_id,mp.team,u.elo AS before,opponent.average_elo,
            CASE WHEN mp.team=${winner}::match_team THEN 1.0 ELSE 0.0 END AS score
          FROM match_players mp JOIN users u ON u.id=mp.user_id
          JOIN team_averages opponent ON opponent.team<>mp.team WHERE mp.match_id=${matchId}
        ) INSERT INTO elo_transactions (id,user_id,match_id,source_key,before,delta,after,reason)
        SELECT gen_random_uuid()::text,user_id,match_id,'forfeit:'||match_id,before,
          ROUND(32*(score-(1.0/(1.0+POWER(10,(average_elo-before)/400.0)))))::int,
          before+ROUND(32*(score-(1.0/(1.0+POWER(10,(average_elo-before)/400.0)))))::int,
          ${reason}
        FROM ratings ON CONFLICT (user_id,source_key) DO NOTHING`,
      getSql()`UPDATE users u SET elo=e.after,matches_played=u.matches_played+1,updated_at=NOW()
        FROM elo_transactions e WHERE e.match_id=${matchId} AND e.user_id=u.id`,
      getSql()`UPDATE match_players mp SET post_elo=e.after,finished_at=NOW()
        FROM elo_transactions e WHERE e.match_id=${matchId} AND e.match_id=mp.match_id AND e.user_id=mp.user_id`,
    ]);
  }

  const rows = await getSql()`UPDATE matches SET status='completed',players_counted=TRUE
    WHERE id=${matchId} RETURNING id,winning_team AS "winningTeam",
      end_reason AS "endReason",forfeited_by AS "forfeitedBy",
      forfeiting_team AS "forfeitingTeam",ended_at AS "endedAt"`;
  const completed = rows[0] as Omit<MatchOutcome, "status" | "remainingSeconds"> | undefined;
  if (!completed) return null;

  const players = await getSql()`SELECT user_id FROM match_players WHERE match_id=${matchId}`;
  await Promise.allSettled(
    players.map(player =>
      addChallengeProgress(String(player.user_id), "play_matches", 1),
    ),
  );
  return { status: "completed", remainingSeconds: 0, ...completed } satisfies MatchOutcome;
}
