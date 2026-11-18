ALTER TABLE "friendships" ADD COLUMN IF NOT EXISTS "blocked_by" text;--> statement-breakpoint
-- Attribute blocks placed before this column existed, using the audit trail
-- every block already wrote. Rows it can't attribute stay NULL, which the
-- friends API treats as "either party may lift it" (the previous behaviour).
UPDATE "friendships" f SET "blocked_by" = latest.actor_id
FROM (
  SELECT DISTINCT ON (target_id) target_id, actor_id
  FROM "audit_log"
  WHERE action = 'friend.blocked' AND target_type = 'friendship' AND actor_id IS NOT NULL
  ORDER BY target_id, created_at DESC
) latest
WHERE f.id = latest.target_id AND f.status = 'blocked' AND f.blocked_by IS NULL
  AND latest.actor_id IN (f.requester_id, f.addressee_id);
