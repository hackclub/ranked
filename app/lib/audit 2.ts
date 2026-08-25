import { getSql } from "@/db";

export type AuditActor = { id: string; name: string; email: string } | null;

export async function logAudit(entry: {
  actor: AuditActor;
  action: string;
  summary: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await getSql()`INSERT INTO audit_log
        (id, actor_id, actor_name, actor_email, action, summary, target_type, target_id, metadata)
      VALUES (
        ${crypto.randomUUID()}, ${entry.actor?.id ?? null}, ${entry.actor?.name ?? null}, ${entry.actor?.email ?? null},
        ${entry.action}, ${entry.summary}, ${entry.targetType ?? null}, ${entry.targetId ?? null},
        ${JSON.stringify(entry.metadata ?? {})}::jsonb
      )`;
  } catch (error) {
    console.error("Failed to write audit log entry", entry.action, error);
  }
}
