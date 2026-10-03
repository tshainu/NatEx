import { and, count, desc, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { db } from "../database";
import { auditLog } from "../database/schema/shared";

/**
 * Audit viewer reads (§10 M5). Kept apart from shared/audit.ts so that file
 * stays write-only. Rows were redacted when written (shared/redact.ts) and are
 * returned as stored — this file has no update or delete either.
 *
 * Rows written before redaction existed (M4 test fixtures) may still carry full
 * bank account numbers: the log is append-only, so they are left as written and
 * the gap is recorded in task.md rather than "fixed" by rewriting history.
 */

export interface AuditQuery {
  entity?: string;
  entityId?: string;
  actorId?: string;
  /** Prefix match, e.g. "user." or "cod.config". */
  action?: string;
  from?: Date;
  /** Exclusive. */
  to?: Date;
  limit: number;
  offset: number;
}

export async function listAudit(q: AuditQuery) {
  const filters: SQL[] = [];
  if (q.entity) filters.push(eq(auditLog.entity, q.entity));
  if (q.entityId) filters.push(eq(auditLog.entityId, q.entityId));
  if (q.actorId) filters.push(eq(auditLog.actorId, q.actorId));
  // Exact prefix compare, not LIKE: action names contain "_", which LIKE reads
  // as a wildcard (and stripping it made "rate_card." match nothing).
  if (q.action) filters.push(sql`substr(${auditLog.action}, 1, ${q.action.length}) = ${q.action}`);
  if (q.from) filters.push(gte(auditLog.ts, q.from));
  if (q.to) filters.push(lt(auditLog.ts, q.to));
  const where = filters.length ? and(...filters) : undefined;
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const [rows, [total]] = await Promise.all([
    db.select().from(auditLog).where(where).orderBy(desc(auditLog.ts), desc(auditLog.id)).limit(limit).offset(Math.max(q.offset, 0)),
    db.select({ n: count() }).from(auditLog).where(where),
  ]);
  return { rows, total: Number(total?.n ?? 0) };
}

/** Distinct entity names, for the viewer's filter. */
export async function auditEntities(): Promise<string[]> {
  const rows = await db.selectDistinct({ entity: auditLog.entity }).from(auditLog).orderBy(auditLog.entity);
  return rows.map((r) => r.entity);
}
