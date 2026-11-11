import { z } from "zod";
import { authedProc, deskProc, financeProc, mutate } from "../middleware/pipeline";
import { requireRole } from "../middleware/auth";
import * as service from "../modules/cod/service";
import * as identityService from "../modules/identity/service";
import * as alerts from "../modules/cod/alerts";
import { COD_ENTRY_TYPES } from "../modules/cod/accounts";
import * as config from "../modules/cod/config";
import { errors } from "../shared/errors";

/**
 * COD ledger routes — Milestone 4 (PROJECT.md §8 checkpoints 1–3, §10 M4).
 * The rider-cash half of the money module: collections, deposits, banking,
 * reconciliation, and the ops alert worklist. The merchant-facing half —
 * settlement runs, holds, invoices, AR — is routes/finance.ts, split only to
 * stay under the 500-line lint ceiling.
 *
 * Role split, from §6's role table read against §8's checkpoints:
 *   - declaring a deposit is the rider handing cash over        → riderProc
 *   - verifying and banking it is the branch cashier / finance  → financeProc
 *     (ops is deliberately NOT given the banking write: §8's whole point is
 *     that the person who counts the cash is not the person who collected it)
 *   - reversing a ledger entry is finance only, never ops       → financeProc
 *   - the alert worklist is worked by both desks                → deskProc
 *     (ops, finance, admin — never the rider an alert is about; M5 review)
 *   - reads are readProc / staffProc; see the scoping note below
 *
 * ROW SCOPING — READ THIS BEFORE ADDING A ROUTE HERE.
 * `readProc` admits a merchant principal, and PROJECT.md §5 requires a merchant
 * to see only its own rows. The cod service does NOT self-scope: `listEntries`
 * takes a merchantId filter but will happily return the whole network if none is
 * passed. So every route below that admits a merchant pins the filter to the
 * principal's own merchantId rather than trusting the input — see `entries`.
 * A route that cannot be scoped that way is staffProc and excludes merchants.
 */

const entryType = z.enum(COD_ENTRY_TYPES);
const depositStatus = z.enum(["declared", "verified", "banked", "rejected"]);
const alertKind = z.enum(alerts.ALERT_KINDS);
const alertStatus = z.enum(["open", "acknowledged", "resolved"]);
const money = z.number().int().positive();

/** COD field reads: riders may read only their own position; desks may read any. */
const riderCashReadProc = authedProc.use(requireRole("ops", "admin", "finance", "rider"));
/** The ledger is available to desks, merchants, and a rider's own field session. */
const ledgerReadProc = authedProc.use(requireRole("ops", "admin", "finance", "rider", "merchant"));
/** A deposit declaration is a rider/ops/admin action, never a finance or field-transport action. */
const depositDeclareProc = authedProc.use(requireRole("rider", "ops", "admin"));

function assertRiderSelf(principal: { role: string; userId: string }, riderId: string, message: string): void {
  if (principal.role === "rider" && principal.userId !== riderId) errors.forbidden(message);
}

async function opsCodBranchScope(principal: { branchId?: string | null }, requestedBranchId?: string) {
  if (!principal.branchId) errors.forbidden("This operations account is not assigned to a branch.");
  const allowed = await identityService.codLedgerBranchScope(principal.branchId!);
  if (requestedBranchId && !allowed.includes(requestedBranchId)) {
    errors.forbidden("The requested branch is outside your Admin-assigned COD scope.");
  }
  return requestedBranchId ? [requestedBranchId] : allowed;
}

// ────────────────────────────────────────────────────────────── the ledger

/**
 * The ledger browser. A merchant principal is pinned to its own rows; a
 * merchant asking for someone else's merchantId is refused outright rather than
 * silently re-scoped, because silently returning different data than was asked
 * for is how a caller ends up trusting a filter that does not hold.
 */
export const entries = ledgerReadProc
  .input(
    z.object({
      type: z.array(entryType).optional(),
      riderId: z.string().optional(),
      merchantId: z.string().optional(),
      branchId: z.string().optional(),
      parcelId: z.string().optional(),
      awb: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    }),
  )
  .handler(async ({ input, context }) => {
    const { principal } = context;
    const { branchId, ...filters } = input;
    if (principal.role === "merchant") {
      if (!principal.merchantId) errors.forbidden("This account is not linked to a merchant.");
      if (filters.merchantId && filters.merchantId !== principal.merchantId) {
        errors.forbidden("A merchant can only read its own ledger entries.");
      }
      return service.listEntries({ ...filters, merchantId: principal.merchantId ?? undefined });
    }
    if (principal.role === "rider") {
      assertRiderSelf(principal, filters.riderId ?? principal.userId, "A rider can only read their own ledger entries.");
      return service.listEntries({ ...filters, riderId: principal.userId });
    }
    if (principal.role === "ops") {
      const branchIds = await opsCodBranchScope(principal, branchId);
      return service.listEntries({ ...filters, branchIds });
    }
    return service.listEntries({ ...filters, branchIds: branchId ? [branchId] : undefined });
  });

/**
 * Four-way reconciliation (§8's "collected vs deposited vs banked vs settled").
 * Finance/Admin receive the network aggregate; Ops receives only its
 * Admin-assigned hub and child-branch scope.
 */
export const reconciliation = deskProc
  .input(
    z.object({
      riderId: z.string().optional(),
      merchantId: z.string().optional(),
      branchId: z.string().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    if (context.principal.role === "ops") {
      const branchIds = await opsCodBranchScope(context.principal, input.branchId);
      return service.reconciliation({ ...input, branchIds });
    }
    return service.reconciliation(input.branchId ? { ...input, branchIds: [input.branchId] } : input);
  });

/**
 * The four checkpoints per day over a window. Finance/Admin see the network;
 * Operations is pinned to the assigned hub plus Admin-assigned branches.
 */
export const dailyFlow = deskProc
  .input(z.object({ days: z.number().int().min(7).max(90).default(30) }))
  .handler(async ({ input, context }) => {
    const branchIds = context.principal.role === "ops" ? await opsCodBranchScope(context.principal) : undefined;
    return service.dailyFlow(input.days, new Date(), branchIds);
  });

/** One rider's cash-in-hand — the §8 invariant, per rider, to the cent. */
export const riderCash = riderCashReadProc
  .input(z.object({ riderId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    assertRiderSelf(context.principal, input.riderId, "A rider can only read their own cash liability.");
    const branchIds = context.principal.role === "ops" ? await opsCodBranchScope(context.principal) : undefined;
    return service.riderCashLiability(input.riderId, branchIds);
  });

/**
 * What a rider is still carrying. The rider app's own screen, so a rider may
 * read it for themselves and nobody else; staff may read any.
 */
/** Rider cash positions, largest first — Finance is global; Ops is branch-scoped. */
export const riderCashBoard = deskProc
  .input(z.object({}))
  .handler(async ({ context }) => {
    const branchIds = context.principal.role === "ops" ? await opsCodBranchScope(context.principal) : undefined;
    return service.riderCashBoard(branchIds);
  });

export const myUndeposited = riderCashReadProc
  .input(z.object({ riderId: z.string().optional() }))
  .handler(async ({ input, context }) => {
    const { principal } = context;
    const target = principal.role === "rider" ? principal.userId : (input.riderId ?? principal.userId);
    if (principal.role === "rider" && input.riderId && input.riderId !== principal.userId) {
      errors.forbidden("A rider can only see their own undeposited collections.");
    }
    const branchIds = principal.role === "ops" ? await opsCodBranchScope(principal) : undefined;
    return service.undepositedCollections(target, branchIds);
  });

/** Collected and not deposited past the §8 window — the escalation list. */
export const stale = deskProc
  .input(z.object({}))
  .handler(async ({ context }) => {
    const branchIds = context.principal.role === "ops" ? await opsCodBranchScope(context.principal) : undefined;
    return service.staleCollections(new Date(), branchIds);
  });

/**
 * Whether this rider may take more parcels. Called by dispatch before assigning
 * work (§8's cash ceiling control) — a read, not a write, so it can be polled.
 */
export const cashCeiling = riderCashReadProc
  .input(z.object({ riderId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    assertRiderSelf(context.principal, input.riderId, "A rider can only check their own cash ceiling.");
    if (context.principal.role === "ops") {
      const branchIds = await opsCodBranchScope(context.principal);
      const rider = await identityService.getUserById(input.riderId);
      if (!rider || !rider.roles.includes("rider") || !branchIds.includes(rider.branchId)) {
        errors.forbidden("Operations can check the cash ceiling only for a rider assigned within their COD scope.");
      }
    }
    return service.checkCashCeiling(input.riderId);
  });

// ───────────────────────────────────────────────────────────── deposits

export const deposits = deskProc
  .input(
    z.object({
      branchId: z.string().optional(),
      riderId: z.string().optional(),
      status: z.array(depositStatus).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  )
  .handler(async ({ input, context }) => {
    if (context.principal.role === "ops") {
      const branchIds = await opsCodBranchScope(context.principal, input.branchId);
      return service.listDeposits({ ...input, branchId: undefined, branchIds });
    }
    return service.listDeposits({ ...input, branchIds: input.branchId ? [input.branchId] : undefined });
  });

/** The deposit register, paged server-side (§11). */
export const depositPage = deskProc
  .input(
    z.object({
      branchId: z.string().optional(),
      riderId: z.string().optional(),
      status: z.array(depositStatus).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(25),
    }),
  )
  .handler(async ({ input, context }) => {
    const scopedInput = context.principal.role === "ops"
      ? { ...input, branchId: undefined, branchIds: await opsCodBranchScope(context.principal, input.branchId) }
      : { ...input, branchIds: input.branchId ? [input.branchId] : undefined };
    return {
      ...(await service.depositPage({
        branchId: scopedInput.branchId,
        branchIds: scopedInput.branchIds,
        riderId: scopedInput.riderId,
        status: scopedInput.status,
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      })),
      page: input.page,
      pageSize: input.pageSize,
    };
  });

/**
 * §8 checkpoint 2 — the rider declares what they are handing over.
 *
 * The rider is taken from the principal, never the input: a rider declaring a
 * deposit "for" another rider would move a cash liability off the person who
 * actually holds it, which is the one thing this ledger exists to prevent. Ops
 * may record a declaration on a rider's behalf (dead device) and must then name
 * the rider explicitly.
 */
export const declareDeposit = depositDeclareProc
  .input(
    z.object({
      riderId: z.string().optional(),
      riderName: z.string().min(1).optional(),
      branchId: z.string().min(1),
      declaredCents: money,
      entryIds: z.array(z.string().min(1)).min(1).max(500),
      note: z.string().max(500).optional(),
    }),
  )
  .handler(({ input, context }) => {
    const { principal } = context;
    const onOwnBehalf = principal.role === "rider";
    if (onOwnBehalf && input.riderId && input.riderId !== principal.userId) {
      errors.forbidden("A rider can only declare their own deposit.");
    }
    if (!onOwnBehalf && !input.riderId) {
      errors.badRequest("Naming the rider is required when recording a deposit on their behalf.");
    }
    if ((principal.role === "rider" || principal.role === "ops") && input.branchId !== principal.branchId) {
      errors.forbidden("A rider or operations user can only declare a deposit at their assigned branch.");
    }
    const riderId = onOwnBehalf ? principal.userId : input.riderId!;
    const riderName = onOwnBehalf ? principal.name : (input.riderName ?? riderId);

    return mutate(
      context,
      input,
      {
        route: "cod.declareDeposit",
        entity: "cod_deposit",
        entityId: (r) => (r as { id: string }).id,
        action: "cod.deposit_declared",
      },
      () =>
        service.declareDeposit({
          riderId,
          riderName,
          branchId: input.branchId,
          declaredCents: input.declaredCents,
          entryIds: input.entryIds,
          note: input.note ?? null,
          actor: principal,
        }),
    );
  });

/**
 * §8 checkpoint 3a — the cashier counts it. `countedCents` is what gets banked;
 * a gap against the ledger posts a VARIANCE entry, and a gap against the
 * rider's own declaration posts nothing but demands a reason. See task.md's
 * "Deposit variance" section for why those are two different numbers.
 */
export const verifyDeposit = financeProc
  .input(
    z.object({
      depositId: z.string().min(1),
      countedCents: z.number().int().nonnegative(),
      varianceReason: z.string().max(500).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "cod.verifyDeposit",
        entity: "cod_deposit",
        entityId: () => input.depositId,
        action: "cod.deposit_verified",
      },
      () =>
        service.verifyDeposit({
          depositId: input.depositId,
          countedCents: input.countedCents,
          varianceReason: input.varianceReason ?? null,
          actor: context.principal,
        }),
    ),
  );

/** §8 checkpoint 3b — the cash reaches the bank, and merchants start accruing. */
export const bankDeposit = financeProc
  .input(
    z.object({
      depositId: z.string().min(1),
      bankRef: z.string().min(1).max(120),
      bankAccount: z.string().min(1).max(120),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "cod.bankDeposit",
        entity: "cod_deposit",
        entityId: () => input.depositId,
        action: "cod.deposit_banked",
      },
      () => service.bankDeposit({ ...input, actor: context.principal }),
    ),
  );

// ──────────────────────────────────────────────────────────── corrections

/**
 * The only way to change the ledger (§11: `cod_entry` has no UPDATE or DELETE
 * path). Finance only, and the reason is mandatory — it is the audit trail.
 */
export const reverseEntry = financeProc
  .input(
    z.object({
      entryId: z.string().min(1),
      reason: z.string().min(3).max(500),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "cod.reverseEntry",
        entity: "cod_entry",
        entityId: (r) => (r as { reversal: { id: string } }).reversal.id,
        action: "cod.entry_reversed",
      },
      () => service.reverseEntry({ ...input, actor: context.principal }),
    ),
  );

// ─────────────────────────────────────────────── the nightly invariant

/**
 * §8's nightly balance check, exposed as a read of past runs plus a manual
 * trigger. The schedule lives in jobs/nightly.ts; this is here so finance can
 * see last night's result and re-run it after a correction without waiting a
 * day.
 */
export const invariantRuns = financeProc
  .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
  .handler(({ input }) => service.listInvariantRuns(input.limit));

export const runInvariant = financeProc
  .input(z.object({}))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "cod.runInvariant",
        entity: "cod_invariant_run",
        entityId: (r) => (r as { runId: string }).runId,
        action: "cod.invariant_run",
        // A manual re-run after a correction is the point; replaying one
        // stored response would defeat it.
        idempotency: false,
      },
      () => service.runBalanceInvariant(),
    ),
  );

// ──────────────────────────────────────────────────────── finance config

const configKey = z.enum(Object.values(config.CONFIG_KEYS) as [config.ConfigKey, ...config.ConfigKey[]]);

/** Fees, tax switches, the cash ceiling and the settlement calendar (§8, §15). */
export const listConfig = deskProc.input(z.object({})).handler(() => config.listConfig());

/**
 * Change one money rule. Finance only; the reason is mandatory because a future
 * reader finding a zero fee must be able to tell a promotion from a bug. The
 * cache is cleared inside setConfigValue, so the dispatch gate and the
 * settlement engine see the new value on their next read.
 */
export const setConfig = financeProc
  .input(
    z.object({
      key: configKey,
      value: z.number().int(),
      reason: z.string().trim().min(5).max(500),
    }),
  )
  .handler(({ input, context }) => {
    const why = config.configValueProblem(input.key, input.value);
    if (why) errors.badRequest(`${input.key}: ${why}`, { key: input.key, value: input.value });
    return mutate(
      context,
      input,
      { route: "cod.setConfig", entity: "cod_finance_config", entityId: () => input.key, action: "cod.config_set" },
      async () => {
        const before = (await config.listConfig()).find((r) => r.key === input.key)!;
        await config.setConfigValue({
          key: input.key,
          value: input.value,
          note: input.reason,
          actorName: context.principal.name,
        });
        return { key: input.key, before: before.value, after: input.value };
      },
    );
  });

// ─────────────────────────────────────────────────────── alert worklist

export const listAlerts = deskProc
  .input(
    z.object({
      status: z.array(alertStatus).optional(),
      kind: alertKind.optional(),
      audience: z.enum(["ops", "finance"]).optional(),
      riderId: z.string().optional(),
      merchantId: z.string().optional(),
      actionRequiredOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(100),
    }),
  )
  .handler(({ input }) =>
    alerts.listAlerts({
      status: input.status,
      kind: input.kind,
      audience: input.audience,
      riderId: input.riderId,
      merchantId: input.merchantId,
      actionRequiredOnly: input.actionRequiredOnly,
      limit: input.limit,
    }),
  );

/** The alert worklist, paged server-side (§11). */
export const alertPage = deskProc
  .input(
    z.object({
      status: z.array(alertStatus).optional(),
      kind: alertKind.optional(),
      audience: z.enum(["ops", "finance"]).optional(),
      actionRequiredOnly: z.boolean().default(false),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(25),
    }),
  )
  .handler(async ({ input }) => ({
    ...(await alerts.alertPage({
      status: input.status,
      kind: input.kind,
      audience: input.audience,
      actionRequiredOnly: input.actionRequiredOnly,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    })),
    page: input.page,
    pageSize: input.pageSize,
  }));

export const alertCounts = deskProc
  .input(z.object({}))
  .handler(() => alerts.alertCounts());

export const getAlert = deskProc
  .input(z.object({ alertId: z.string().min(1) }))
  .handler(({ input }) => alerts.getAlert(input.alertId));

/** "I am on it" — stops a second desk picking up the same escalation. */
export const acknowledgeAlert = deskProc
  .input(z.object({ alertId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "cod.acknowledgeAlert",
        entity: "cod_ops_alert",
        entityId: () => input.alertId,
        action: "cod.alert_acknowledged",
      },
      () => alerts.acknowledgeAlert(input.alertId, context.principal),
    ),
  );

/** The note is mandatory in the service: a money escalation is never closed silently. */
export const resolveAlert = deskProc
  .input(
    z.object({
      alertId: z.string().min(1),
      note: z.string().min(3).max(1000),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "cod.resolveAlert",
        entity: "cod_ops_alert",
        entityId: () => input.alertId,
        action: "cod.alert_resolved",
      },
      () => alerts.resolveAlert(input.alertId, input.note, context.principal),
    ),
  );

/** Router namespace — composed into the root router in api/index.ts. */
export const cod = {
  entries,
  reconciliation,
  dailyFlow,
  riderCash,
  riderCashBoard,
  myUndeposited,
  stale,
  cashCeiling,
  deposits,
  depositPage,
  declareDeposit,
  verifyDeposit,
  bankDeposit,
  reverseEntry,
  invariantRuns,
  runInvariant,
  listConfig,
  setConfig,
  listAlerts,
  alertPage,
  alertCounts,
  getAlert,
  acknowledgeAlert,
  resolveAlert,
};
