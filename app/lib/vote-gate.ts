import { getSql } from "@/db";

export type VoteGate = {
  required: number;
  cast: number;
  available: boolean;
  due: boolean;
  deferred: boolean;
};

export async function getVoteGate(userId: string, matchesPlayed: number): Promise<VoteGate> {
  const rows = await getSql()`SELECT
      (SELECT COUNT(*)::int FROM votes WHERE voter_id=${userId}) AS cast,
      EXISTS (
        SELECT 1 FROM matches m
        WHERE m.status='voting'
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp WHERE mp.match_id=m.id AND mp.user_id=${userId}
          )
          AND NOT EXISTS (
            SELECT 1 FROM votes v WHERE v.match_id=m.id AND v.voter_id=${userId}
          )
          AND (
            SELECT COUNT(DISTINCT p.team)::int FROM publications p WHERE p.match_id=m.id
          )=2
      ) AS available`;
  const cast = Number(rows[0]?.cast ?? 0);
  const required = Math.floor(matchesPlayed / 3);
  const available = Boolean(rows[0]?.available);
  const owed = cast < required;
  return {
    required,
    cast,
    available,
    due: owed && available,
    deferred: owed && !available,
  };
}
