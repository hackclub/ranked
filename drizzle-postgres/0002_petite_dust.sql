ALTER TABLE "match_players" ADD COLUMN "presence_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "disconnect_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "forfeited_by" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "forfeiting_team" "match_team";