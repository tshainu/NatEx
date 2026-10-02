import { db } from "../database";
import { auditLog } from "../database/schema/shared";
import { prefixedId } from "./ulid";
import type { Principal } from "./auth";
import { redactForAudit } from "./redact";

/**
 * Append-only audit writer (PROJECT.md §4 step 6, §5).
 * There is intentionally no update or delete function in this file.
 * Payloads are redacted before they are written — see shared/redact.ts.
 */
export interface AuditInput {
  entity: string;
  entityId: string;
  action: string;
  actor?: Principal | null;
  requestId?: string;
  before?: unknown;
  after?: unknown;
  deviceId?: string | null;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    id: prefixedId("aud"),
    entity: input.entity,
    entityId: input.entityId,
    action: input.action,
    actorId: input.actor?.userId ?? null,
    actorRole: input.actor?.role ?? null,
    branchId: input.actor?.branchId ?? null,
    deviceId: input.deviceId ?? input.actor?.deviceId ?? null,
    requestId: input.requestId ?? null,
    beforeJson: input.before === undefined ? null : JSON.stringify(redactForAudit(input.before)),
    afterJson: input.after === undefined ? null : JSON.stringify(redactForAudit(input.after)),
    ts: new Date(),
  });
}
