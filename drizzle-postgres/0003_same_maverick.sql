CREATE TYPE "public"."duo_invite_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "duo_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"status" "duo_invite_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matchmaking_queue" ADD COLUMN "party_key" text;--> statement-breakpoint
ALTER TABLE "duo_invites" ADD CONSTRAINT "duo_invites_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duo_invites" ADD CONSTRAINT "duo_invites_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duo_invites_from_idx" ON "duo_invites" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "duo_invites_to_idx" ON "duo_invites" USING btree ("to_user_id");