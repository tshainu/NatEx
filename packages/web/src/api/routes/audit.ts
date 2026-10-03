import { z } from "zod";
import { adminProc } from "../middleware/pipeline";
import { auditEntities, listAudit } from "../shared/audit-reader";

/**
 * Audit viewer (§10 M5). Admin only, read only — the log is append-only
 * (§5/§11) and this namespace has no write. Rows are returned as stored, which
 * means already redacted (shared/redact.ts).
 */
export const list = adminProc
  .input(
    z.object({
      entity: z.string().max(60).optional(),
      entityId: z.string().max(80).optional(),
      actorId: z.string().max(80).optional(),
      action: z.string().max(60).optional(),
      /** ISO instants. `to` is exclusive. */
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
  )
  .handler(({ input }) =>
    listAudit({
      ...input,
      from: input.from ? new Date(input.from) : undefined,
      to: input.to ? new Date(input.to) : undefined,
    }),
  );

export const entities = adminProc.handler(() => auditEntities());

export const audit = { list, entities };
