export type Experience = "beginner" | "intermediate" | "expert";

export const STARTING_ELO: Record<Experience, number> = {
  beginner: 900,
  intermediate: 1200,
  expert: 1500,
};

export type RankTier = {
  key: "comet" | "asteroid" | "planet" | "star" | "supernova" | "galaxy";
  min: number;
  // Reuses the app's existing brand tokens (globals.css :root) rather than
  // inventing a separate palette — each tier gets one of the six already on
  // hand, in ascending "temperature" so the elo bar itself signals the climb.
  color: string;
};

// Ordered lowest to highest, with the gap between each tier roughly doubling
// (150 -> 300 -> 600 -> 1200) instead of a flat step every time — climbing
// gets harder the higher you go, matching how the top of a real ladder always
// thins out. Beginner/intermediate/expert starting ELOs (900, 1200, 1500)
// land exactly on comet, planet, and star's floors respectively, so most
// players cluster between planet and star from their very first placement.
// Galaxy's floor sits 1800 above the expert starting point — reachable only
// by winning well past a starting placement — so it stays a rare, ~1-2%-of-
// players tier rather than a common one.
export const RANK_TIERS: RankTier[] = [
  { key: "comet", min: 0, color: "var(--blue)" },
  { key: "asteroid", min: 1050, color: "var(--orange)" },
  { key: "planet", min: 1200, color: "var(--green)" },
  { key: "star", min: 1500, color: "var(--pink)" },
  { key: "supernova", min: 2100, color: "var(--red)" },
  { key: "galaxy", min: 3300, color: "var(--purple)" },
];

export function rankTierForElo(elo: number): RankTier {
  let current = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (elo >= tier.min) current = tier;
  }
  return current;
}

// Applied to the ELO a player *gains* on a win — never to a loss. Comet and
// asteroid get no bonus; planet and up escalate. The actual ELO settlement
// (app/api/votes/route.ts and app/lib/match-lifecycle.ts) applies this same
// table inline in SQL, since it runs inside a single transactional query —
// keep the thresholds and multipliers there in sync with this table.
export const WIN_MULTIPLIER: Record<RankTier["key"], number> = {
  comet: 1,
  asteroid: 1,
  planet: 1.05,
  star: 1.25,
  supernova: 1.5,
  galaxy: 2,
};

export function winMultiplierForElo(elo: number): number {
  return WIN_MULTIPLIER[rankTierForElo(elo).key];
}

function nextRankTier(current: RankTier): RankTier | null {
  const index = RANK_TIERS.findIndex((tier) => tier.key === current.key);
  return index >= 0 && index < RANK_TIERS.length - 1 ? RANK_TIERS[index + 1] : null;
}

// Progress (0-100) from the current tier's floor toward the next tier's
// floor. Pinned at 100 with no further target once a player reaches galaxy.
export function rankProgress(elo: number): {
  tier: RankTier;
  next: RankTier | null;
  progress: number;
  toNext: number;
} {
  const tier = rankTierForElo(elo);
  const next = nextRankTier(tier);
  if (!next) return { tier, next: null, progress: 100, toNext: 0 };
  const span = next.min - tier.min;
  const progress = Math.max(0, Math.min(100, ((elo - tier.min) / span) * 100));
  return { tier, next, progress, toNext: Math.max(0, next.min - elo) };
}
