import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const sql = neon(process.env.DATABASE_URL);

await sql.query(`
    CREATE TABLE IF NOT EXISTS hackatime_connections (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      hackatime_user_id text NOT NULL UNIQUE,
      access_token_encrypted text NOT NULL,
      api_key_encrypted text NOT NULL,
      scopes text NOT NULL DEFAULT 'profile read',
      primary_email text,
      slack_id text,
      github_username text,
      expires_at timestamptz,
      last_heartbeat_at timestamptz,
      connected_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
await sql.query(`
    CREATE INDEX IF NOT EXISTS hackatime_connections_slack_idx
    ON hackatime_connections(slack_id)
  `);
await sql.query(`
    ALTER TABLE hackatime_connections
    ADD COLUMN IF NOT EXISTS api_key_encrypted text
  `);
// Connections created before heartbeat support cannot submit activity until the
// user authorizes again, so remove those incomplete rows and keep the table
// invariant aligned with db/schema.ts.
await sql.query(`
    DELETE FROM hackatime_connections
    WHERE api_key_encrypted IS NULL
  `);
await sql.query(`
    ALTER TABLE hackatime_connections
    ALTER COLUMN api_key_encrypted SET NOT NULL
  `);
await sql.query(`
    ALTER TABLE hackatime_connections
    ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz
  `);
console.log("Hackatime connection schema is ready.");
