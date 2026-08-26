CREATE TABLE "hack_club_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"profile_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "hca_address_id" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "airtable_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "airtable_record_id" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "airtable_error" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "airtable_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "airtable_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hack_club_profiles" ADD CONSTRAINT "hack_club_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;