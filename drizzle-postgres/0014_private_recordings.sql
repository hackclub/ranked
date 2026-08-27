ALTER TABLE "matchmaking_queue"
  ADD COLUMN "recording_consented_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "match_recording_consents" (
  "match_id" text NOT NULL,
  "user_id" text NOT NULL,
  "policy_version" text NOT NULL,
  "consented_at" timestamp with time zone NOT NULL,
  CONSTRAINT "match_recording_consents_match_id_user_id_pk" PRIMARY KEY("match_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "match_recordings" (
  "id" text PRIMARY KEY NOT NULL,
  "match_id" text NOT NULL,
  "user_id" text NOT NULL,
  "participant_name" text NOT NULL,
  "participant_email" text NOT NULL,
  "status" text DEFAULT 'recording' NOT NULL,
  "mime_type" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "match_recordings_match_user_unique" UNIQUE("match_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "recording_segments" (
  "id" text PRIMARY KEY NOT NULL,
  "recording_id" text NOT NULL,
  "segment_index" integer NOT NULL,
  "object_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "uploaded_at" timestamp with time zone,
  CONSTRAINT "recording_segments_object_key_unique" UNIQUE("object_key"),
  CONSTRAINT "recording_segments_recording_index_unique" UNIQUE("recording_id", "segment_index")
);
--> statement-breakpoint
ALTER TABLE "match_recording_consents" ADD CONSTRAINT "match_recording_consents_match_id_matches_id_fk"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_recording_consents" ADD CONSTRAINT "match_recording_consents_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_recordings" ADD CONSTRAINT "match_recordings_match_id_matches_id_fk"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_recordings" ADD CONSTRAINT "match_recordings_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_recording_id_match_recordings_id_fk"
  FOREIGN KEY ("recording_id") REFERENCES "public"."match_recordings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "match_recording_consents_user_idx" ON "match_recording_consents" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "match_recordings_match_idx" ON "match_recordings" USING btree ("match_id");
--> statement-breakpoint
CREATE INDEX "match_recordings_expires_idx" ON "match_recordings" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "recording_segments_recording_idx" ON "recording_segments" USING btree ("recording_id");
