-- Usernames used to be copied straight from Slack display names, which are
-- free text: they could contain anything and could duplicate another player's.
-- Bring every stored username in line with the rules the app now enforces
-- (lowercase letters, numbers, periods, underscores, hyphens; unique) before
-- the constraint below makes them permanent.

-- 1. Normalise the ones that only differ by case, spacing or a leading "@".
UPDATE "users" SET "slack_username" = regexp_replace(lower(btrim(regexp_replace("slack_username", '^\s*@', ''))), '\s+', '-', 'g')
WHERE "slack_username" IS NOT NULL
  AND "slack_username" <> regexp_replace(lower(btrim(regexp_replace("slack_username", '^\s*@', ''))), '\s+', '-', 'g');--> statement-breakpoint

-- 2. Clear anything that still isn't a valid username. Those players are
--    asked to choose one the next time they open the app.
UPDATE "users" SET "slack_username" = NULL
WHERE "slack_username" IS NOT NULL AND "slack_username" !~ '^[a-z0-9._-]{1,80}$';--> statement-breakpoint

-- 3. Where several players ended up with the same username, the account that
--    has existed longest keeps it and the others are asked to choose again.
UPDATE "users" u SET "slack_username" = NULL
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "slack_username" ORDER BY "created_at", "id") AS position
  FROM "users" WHERE "slack_username" IS NOT NULL
) ranked
WHERE u."id" = ranked."id" AND ranked.position > 1;--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_slack_username_unique" UNIQUE("slack_username");
