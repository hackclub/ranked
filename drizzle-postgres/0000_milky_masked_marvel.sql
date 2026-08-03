CREATE TYPE "public"."challenge_type" AS ENUM('play_matches', 'code_seconds', 'add_friends');--> statement-breakpoint
CREATE TYPE "public"."experience_level" AS ENUM('beginner', 'intermediate', 'expert');--> statement-breakpoint
CREATE TYPE "public"."friendship_status" AS ENUM('pending', 'accepted', 'declined', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."match_mode" AS ENUM('solo', 'duo');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('active', 'voting', 'finalizing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'approved', 'shipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."match_team" AS ENUM('blue', 'red');--> statement-breakpoint
CREATE TABLE "daily_challenge_progress" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"type" "challenge_type" NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"target" integer NOT NULL,
	"reward_elo" integer DEFAULT 0 NOT NULL,
	"reward_h_bucks" integer DEFAULT 0 NOT NULL,
	"reward_claimed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_challenge_progress_user_id_day_type_pk" PRIMARY KEY("user_id","day","type")
);
--> statement-breakpoint
CREATE TABLE "elo_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"match_id" text,
	"source_key" text NOT NULL,
	"before" integer NOT NULL,
	"delta" integer NOT NULL,
	"after" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" text PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"addressee_id" text NOT NULL,
	"pair_key" text NOT NULL,
	"status" "friendship_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_pair_key_unique" UNIQUE("pair_key")
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"match_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team" "match_team" NOT NULL,
	"slot" integer NOT NULL,
	"pre_elo" integer NOT NULL,
	"post_elo" integer,
	"coding_seconds" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_players_match_id_user_id_pk" PRIMARY KEY("match_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "match_snapshots" (
	"match_id" text NOT NULL,
	"team" "match_team" NOT NULL,
	"html" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_snapshots_match_id_team_pk" PRIMARY KEY("match_id","team")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" "match_mode" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"theme" text NOT NULL,
	"status" "match_status" DEFAULT 'active' NOT NULL,
	"winning_team" "match_team",
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"voting_ends_at" timestamp with time zone,
	"players_counted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matchmaking_queue" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" "match_mode" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"experience" "experience_level" NOT NULL,
	"elo" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"team" "match_team" NOT NULL,
	"repository_url" text NOT NULL,
	"pages_url" text NOT NULL,
	"github_repo" text NOT NULL,
	"published_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"cost" integer NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"shipping" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"slack_id" text,
	"verification_status" text,
	"experience" "experience_level",
	"elo" integer DEFAULT 1500 NOT NULL,
	"matches_played" integer DEFAULT 0 NOT NULL,
	"coding_seconds" integer DEFAULT 0 NOT NULL,
	"h_bucks" integer DEFAULT 0 NOT NULL,
	"avatar" jsonb DEFAULT '{"color":"#497CBF","eyes":2,"mouths":1}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_slack_id_unique" UNIQUE("slack_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"voter_id" text NOT NULL,
	"choice" "match_team" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_challenge_progress" ADD CONSTRAINT "daily_challenge_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elo_transactions" ADD CONSTRAINT "elo_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elo_transactions" ADD CONSTRAINT "elo_transactions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addressee_id_users_id_fk" FOREIGN KEY ("addressee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_snapshots" ADD CONSTRAINT "match_snapshots_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchmaking_queue" ADD CONSTRAINT "matchmaking_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "elo_user_source_unique" ON "elo_transactions" USING btree ("user_id","source_key");--> statement-breakpoint
CREATE INDEX "elo_match_idx" ON "elo_transactions" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "friendships_requester_idx" ON "friendships" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "friendships_addressee_idx" ON "friendships" USING btree ("addressee_id");--> statement-breakpoint
CREATE INDEX "match_players_user_idx" ON "match_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "match_players_match_team_idx" ON "match_players" USING btree ("match_id","team");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "matches_ends_idx" ON "matches" USING btree ("ends_at");--> statement-breakpoint
CREATE INDEX "queue_match_idx" ON "matchmaking_queue" USING btree ("mode","duration_minutes","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_match_team_unique" ON "publications" USING btree ("match_id","team");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "shop_orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_match_voter_unique" ON "votes" USING btree ("match_id","voter_id");--> statement-breakpoint
CREATE INDEX "votes_match_idx" ON "votes" USING btree ("match_id");