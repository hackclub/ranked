ALTER TABLE "matches" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "matches" SET "is_test" = TRUE WHERE "mode" = 'admin';