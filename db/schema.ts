import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const experienceEnum = pgEnum("experience_level", ["beginner", "intermediate", "expert"]);
export const matchModeEnum = pgEnum("match_mode", ["solo", "duo", "admin"]);
export const matchStatusEnum = pgEnum("match_status", ["active", "voting", "finalizing", "completed", "cancelled"]);
export const teamEnum = pgEnum("match_team", ["blue", "red"]);
export const friendshipStatusEnum = pgEnum("friendship_status", ["pending", "accepted", "declined", "blocked"]);
export const duoInviteStatusEnum = pgEnum("duo_invite_status", ["pending", "accepted", "declined", "missed"]);
export const orderStatusEnum = pgEnum("order_status", ["pending", "approved", "shipped", "cancelled"]);
export const challengeTypeEnum = pgEnum("challenge_type", ["play_matches", "code_seconds", "add_friends"]);
export const reportTypeEnum = pgEnum("report_type", ["misconduct", "ai"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  slackId: text("slack_id").unique(),
  verificationStatus: text("verification_status"),
  experience: experienceEnum("experience"),
  elo: integer("elo").notNull().default(1500),
  matchesPlayed: integer("matches_played").notNull().default(0),
  codingSeconds: integer("coding_seconds").notNull().default(0),
  hBucks: integer("h_bucks").notNull().default(0),
  avatar: jsonb("avatar").$type<{ color: string; eyes: number; mouths: number; eyeStyle?: string; mouthStyle?: string }>().notNull().default({ color: "#497CBF", eyes: 2, mouths: 1 }),
  avatarUrl: text("avatar_url"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hackatimeConnections = pgTable("hackatime_connections", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  hackatimeUserId: text("hackatime_user_id").notNull().unique(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  scopes: text("scopes").notNull().default("profile read"),
  primaryEmail: text("primary_email"),
  slackId: text("slack_id"),
  githubUsername: text("github_username"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("hackatime_connections_slack_idx").on(table.slackId)]);

// Birthdates and shipping addresses are sensitive HCA data. The application
// stores them as one encrypted payload rather than exposing individual PII
// columns or putting a potentially large address list in the session cookie.
export const hackClubProfiles = pgTable("hack_club_profiles", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  profileEncrypted: text("profile_encrypted").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matches = pgTable("matches", {
  id: text("id").primaryKey(),
  mode: matchModeEnum("mode").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  theme: text("theme").notNull(),
  status: matchStatusEnum("status").notNull().default("active"),
  winningTeam: teamEnum("winning_team"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  votingEndsAt: timestamp("voting_ends_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  forfeitedBy: text("forfeited_by"),
  forfeitingTeam: teamEnum("forfeiting_team"),
  playersCounted: boolean("players_counted").notNull().default(false),
  isTest: boolean("is_test").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("matches_status_idx").on(table.status), index("matches_ends_idx").on(table.endsAt)]);

export const matchPlayers = pgTable("match_players", {
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  team: teamEnum("team").notNull(),
  slot: integer("slot").notNull(),
  preElo: integer("pre_elo").notNull(),
  postElo: integer("post_elo"),
  codingSeconds: integer("coding_seconds").notNull().default(0),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  presenceConfirmedAt: timestamp("presence_confirmed_at", { withTimezone: true }),
  disconnectStartedAt: timestamp("disconnect_started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.matchId, table.userId] }), index("match_players_user_idx").on(table.userId), index("match_players_match_team_idx").on(table.matchId, table.team)]);

export const matchmakingQueue = pgTable("matchmaking_queue", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  mode: matchModeEnum("mode").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  experience: experienceEnum("experience").notNull(),
  elo: integer("elo").notNull(),
  partyKey: text("party_key"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("queue_match_idx").on(table.mode, table.durationMinutes, table.joinedAt)]);

export const duoInvites = pgTable("duo_invites", {
  id: text("id").primaryKey(),
  fromUserId: text("from_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  toUserId: text("to_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: duoInviteStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("duo_invites_from_idx").on(table.fromUserId), index("duo_invites_to_idx").on(table.toUserId)]);

export const votes = pgTable("votes", {
  id: text("id").primaryKey(),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  voterId: text("voter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  choice: teamEnum("choice").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("votes_match_voter_unique").on(table.matchId, table.voterId), index("votes_match_idx").on(table.matchId)]);

export const eloTransactions = pgTable("elo_transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  matchId: text("match_id").references(() => matches.id, { onDelete: "cascade" }),
  sourceKey: text("source_key").notNull(),
  before: integer("before").notNull(),
  delta: integer("delta").notNull(),
  after: integer("after").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("elo_user_source_unique").on(table.userId, table.sourceKey), index("elo_match_idx").on(table.matchId)]);

export const friendships = pgTable("friendships", {
  id: text("id").primaryKey(),
  requesterId: text("requester_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  addresseeId: text("addressee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pairKey: text("pair_key").notNull().unique(),
  status: friendshipStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("friendships_requester_idx").on(table.requesterId), index("friendships_addressee_idx").on(table.addresseeId)]);

export const dailyChallengeProgress = pgTable("daily_challenge_progress", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  type: challengeTypeEnum("type").notNull(),
  progress: integer("progress").notNull().default(0),
  target: integer("target").notNull(),
  rewardElo: integer("reward_elo").notNull().default(0),
  rewardHBucks: integer("reward_h_bucks").notNull().default(0),
  rewardClaimed: boolean("reward_claimed").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.userId, table.day, table.type] })]);

export const publications = pgTable("publications", {
  id: text("id").primaryKey(),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  team: teamEnum("team").notNull(),
  repositoryUrl: text("repository_url").notNull(),
  pagesUrl: text("pages_url").notNull(),
  githubRepo: text("github_repo").notNull(),
  description: text("description"),
  publishedBy: text("published_by").notNull().references(() => users.id),
  hcaAddressId: text("hca_address_id"),
  airtableStatus: text("airtable_status").notNull().default("pending"),
  airtableRecordId: text("airtable_record_id"),
  airtableError: text("airtable_error"),
  airtableLastAttemptAt: timestamp("airtable_last_attempt_at", { withTimezone: true }),
  airtableSubmittedAt: timestamp("airtable_submitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("publication_match_user_unique").on(table.matchId, table.publishedBy), index("publication_match_team_idx").on(table.matchId, table.team)]);

export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  reporterId: text("reporter_id").notNull().references(() => users.id),
  targetId: text("target_id").notNull().references(() => users.id),
  type: reportTypeEnum("type").notNull(),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("reports_match_idx").on(table.matchId)]);

export const matchSnapshots = pgTable("match_snapshots", {
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  team: teamEnum("team").notNull(),
  html: text("html").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.matchId, table.team] })]);

export const shopOrders = pgTable("shop_orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  itemId: text("item_id").notNull(),
  itemName: text("item_name").notNull(),
  cost: integer("cost").notNull(),
  status: orderStatusEnum("status").notNull().default("pending"),
  shipping: jsonb("shipping").$type<{ name: string; address1: string; address2?: string; city: string; region: string; postalCode: string; country: string }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("orders_user_idx").on(table.userId)]);

// Deliberately has no foreign keys on the actor/target ids: an audit row must stay
// legible even after the account it names is wiped (db:wipe-users) or deleted, so
// the human-readable name/email are captured at write time rather than joined live.
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  summary: text("summary").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("audit_log_created_idx").on(table.createdAt)]);
