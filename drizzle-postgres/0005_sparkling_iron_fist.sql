CREATE TABLE IF NOT EXISTS "hackatime_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"hackatime_user_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"scopes" text DEFAULT 'profile read' NOT NULL,
	"primary_email" text,
	"slack_id" text,
	"github_username" text,
	"expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hackatime_connections_hackatime_user_id_unique" UNIQUE("hackatime_user_id"),
	CONSTRAINT "hackatime_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hackatime_connections_slack_idx" ON "hackatime_connections" USING btree ("slack_id");
