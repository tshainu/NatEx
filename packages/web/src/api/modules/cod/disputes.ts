import { and, count, desc, eq, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../database";
import { codDispute } from "../../database/schema/cod";
import { errors, fail, problem } from "../../shared/errors";
import { formatLkr } from "../../shared/money";
import { enqueue } from "../../shared/outbox";
import { writeAudit } from "../../shared/audit";
import { prefixedId } from "../../shared/ulid";
import { colomboToday } from "../../shared/time";
import type { Principal } from "../../shared/auth";
import { getParcelByAwb } from "../parcels/service";
import { getMerchant } from "../merchants/service";
import { CONFIG_KEYS, configValue } from "./config";
import { clearHold, raiseHold } from "./holds";
import { getInvoice, issueCreditNote } from "./invoicing";

/**
 * MODULE: cod — the dispute queue and the claim register (PROJECT.md §10 M4:
 * "Finance portal: … disputes", "Dispute queue, claim register").
 *
 * One table, two views:
 *   - the DISPUTE QUEUE is every live case, whatever it is about: a COD
 *     shortfall, a charge on an invoice, an SLA complaint
 *   - the CLAIM REGISTER is the subset that is a claim against NatEx's
 *     liability for the goods themselves — `loss` and `damage` — with the
 *     declared value as the ceiling, and its payout history
 *
 * Money rules, each tied to a requirement:
 *   - claims are capped at what the parcel was declared to be worth, and a COD
 *     shortfall at the COD amount; both are SNAPSHOTTED on open so a later
 *     edit to the parcel cannot move the cap (§1 "reconcile to the cent")
 *   - a dispute that touches a parcel's money raises a `dispute` settlement
 *     hold, so the disputed amount cannot be paid out while it is argued
 *     (§8 "Settlement hold: any open variance blocks that merchant's payout")
 *   - maker–checker: whoever opened a case cannot decide it (§8's rule, applied
 *     to the other place NatEx promises money)
 *   - an upheld case must say HOW it was paid — a credit note against an
 *     issued invoice, or a bank transfer with its UTR (§8 checkpoint 5)
 *
 * §4: parcels and merchants are reached through their services; invoices,
 * credit notes and holds are this module's own.
 */

export type DisputeRow = typeof codDispute.$inferSelect;

export const DISPUTE_TYPES = ["cod_shortfall", "damage", "loss", "billing", "sla", "other"] as const;
export type DisputeType = (typeof DISPUTE_TYPES)[number];
/** The claim register: a claim on NatEx's liability for the goods. */
export const CLAIM_TYPES: readonly DisputeType[] = ["damage", "loss"];

export const DISPUTE_STATUSES = ["open", "investigating", "resolved", "rejected", "withdrawn"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const LIVE_STATUSES: readonly DisputeStatus[] = ["open", "investigating"];

export const REMEDIES = ["credit_note", "bank_transfer", "none"] as const;
export type Remedy = (typeof REMEDIES)[number];

/** Types that need a parcel to mean anything. */
const NEEDS_PARCEL: readonly DisputeType[] = ["cod_shortfall", "damage", "loss"];

export const TYPE_LABEL: Record<DisputeType, string> = {
  cod_shortfall: "COD shortfall",
  damage: "Damaged goods",
  loss: "Lost parcel",
  billing: "Invoice charge",
  sla: "Service level",
  other: "Other",
};

function mintDisputeCode(prefix: "DSP" | "CLM"): string {
  const compact = colomboToday().replaceAll("-", "").slice(2);
  return `${prefix}${compact}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

async function load(id: string): Promise<DisputeRow> {
  const [row] = await db.select().from(codDispute).where(eq(codDispute.id, id));
  if (!row) errors.notFound("Dispute");
  return row!;
}

/** §5: a merchant reaching another merchant's case by id gets 404, not 403. */
function assertVisible(row: DisputeRow, actor: Principal): void {
  if (actor.role === "merchant" && row.merchantId !== actor.merchantId) errors.notFound("Dispute");
}

// ─────────────────────────────────────────────────────────────── open

export interface OpenDisputeInput {
  /** Required for staff; ignored for a merchant (pinned to their own). */
  merchantId?: string | null;
  awb?: string | null;
  type: DisputeType;
  /** MONEY: cents. 0 is allowed for a non-monetary complaint (sla/other). */
  claimAmountCents: number;
  description: string;
}

export async function openDispute(input: OpenDisputeInput, actor: Principal): Promise<DisputeRow> {
  let merchantId: string;
  if (actor.role === "merchant") {
    if (!actor.merchantId) errors.forbidden("This account is not linked to a merchant.");
    if (input.merchantId && input.merchantId !== actor.merchantId) {
      errors.forbidden("A merchant can only raise disputes for itself.");
    }
    merchantId = actor.merchantId!;
  } else {
    if (!input.merchantId) errors.badRequest("Name the merchant this dispute is for.");
    merchantId = input.merchantId!;
  }
  const merchant = await getMerchant(merchantId);
  if (!merchant) errors.notFound(`Merchant ${merchantId}`);

  if (!Number.isInteger(input.claimAmountCents) || input.claimAmountCents < 0) {
    errors.badRequest("A claim amount must be a whole number of cents, zero or more.");
  }
  const description = input.description.trim();
  if (description.length < 10) {
    errors.badRequest("Describe the problem in at least 10 characters — finance decides on this text.");
  }

  let parcel: Awaited<ReturnType<typeof getParcelByAwb>> = null;
  if (input.awb?.trim()) {
    parcel = await getParcelByAwb(input.awb);
    // A merchant naming someone else's AWB learns nothing about it (§5).
    if (!parcel || parcel.merchantId !== merchantId) errors.notFound(`Parcel ${input.awb.trim().toUpperCase()}`);
  }
  if (NEEDS_PARCEL.includes(input.type) && !parcel) {
    errors.badRequest(`A ${TYPE_LABEL[input.type].toLowerCase()} dispute must name the parcel's AWB.`);
  }

  // One live case per parcel per type: a second one would split the evidence
  // and could be paid twice. Checked before the caps — "already open" is the
  // answer that matters, whatever the second claim says.
  if (parcel) {
    const [live] = await db
      .select()
      .from(codDispute)
      .where(
        and(
          eq(codDispute.parcelId, parcel.id),
          eq(codDispute.type, input.type),
          inArray(codDispute.status, [...LIVE_STATUSES]),
        ),
      )
      .limit(1);
    if (live) {
      errors.conflict(`${live.code} is already open for ${parcel.awb} (${TYPE_LABEL[input.type]}).`, {
        disputeId: live.id,
        code: live.code,
      });
    }
  }

  // Ceilings, from the parcel as it stands now — and snapshotted below.
  if (input.type === "cod_shortfall") {
    if (parcel!.codAmountCents <= 0) errors.badRequest(`${parcel!.awb} is prepaid; there is no COD to be short of.`);
    if (input.claimAmountCents <= 0 || input.claimAmountCents > parcel!.codAmountCents) {
      fail(
        "BAD_REQUEST",
        problem(
          "claim-exceeds-cap",
          "Claim over the COD amount",
          422,
          `A COD shortfall on ${parcel!.awb} can be at most its COD of ${formatLkr(parcel!.codAmountCents)}.`,
          { capCents: parcel!.codAmountCents, claimAmountCents: input.claimAmountCents },
        ),
      );
    }
  }
  if (CLAIM_TYPES.includes(input.type)) {
    if (input.claimAmountCents <= 0) errors.badRequest("A loss or damage claim must name an amount.");
    if (input.claimAmountCents > parcel!.declaredValueCents) {
      fail(
        "BAD_REQUEST",
        problem(
          "claim-exceeds-cap",
          "Claim over the declared value",
          422,
          `NatEx's liability for ${parcel!.awb} is capped at its declared value of ${formatLkr(parcel!.declaredValueCents)}.`,
          { capCents: parcel!.declaredValueCents, claimAmountCents: input.claimAmountCents },
        ),
      );
    }
  }
  if (input.type === "billing" && input.claimAmountCents <= 0) {
    errors.badRequest("A billing dispute must name the amount being disputed.");
  }

  const slaDays = await configValue(CONFIG_KEYS.DISPUTE_SLA_DAYS);
  const id = prefixedId("dsp");
  const code = mintDisputeCode(CLAIM_TYPES.includes(input.type) ? "CLM" : "DSP");
  const now = new Date();
  await db.insert(codDispute).values({
    id,
    code,
    merchantId,
    merchantName: merchant!.name,
    parcelId: parcel?.id ?? null,
    awb: parcel?.awb ?? null,
    type: input.type,
    claimAmountCents: input.claimAmountCents,
    approvedAmountCents: null,
    status: "open",
    description,
    declaredValueCents: parcel?.declaredValueCents ?? null,
    codAmountCents: parcel?.codAmountCents ?? null,
    slaDueAt: new Date(now.getTime() + slaDays * 86_400_000),
    openedById: actor.userId,
    openedByName: actor.name,
    openedByRole: actor.role,
    createdAt: now,
    updatedAt: now,
  });

  // A case about a parcel's money holds that parcel's line out of the next
  // payout until it closes. Billing disputes are about what the merchant owes
  // NatEx, so they hold nothing; SLA/other carry no money.
  let holdId: string | null = null;
  if (parcel && input.claimAmountCents > 0 && (input.type === "cod_shortfall" || CLAIM_TYPES.includes(input.type))) {
    const { hold } = await raiseHold({
      scope: "parcel",
      reason: "dispute",
      merchantId,
      parcelId: parcel.id,
      awb: parcel.awb,
      disputeId: id,
      amountCents: input.claimAmountCents,
      detail: `${code}: ${TYPE_LABEL[input.type]} claim of ${formatLkr(input.claimAmountCents)} under review.`,
      sourceKey: `dispute:${id}`,
      actor,
    });
    holdId = hold.id;
    await db.update(codDispute).set({ holdId }).where(eq(codDispute.id, id));
  }

  await enqueue("cod.dispute_opened", {
    disputeId: id,
    merchantId,
    parcelId: parcel?.id ?? null,
    awb: parcel?.awb ?? null,
    amountCents: input.claimAmountCents,
    reason: TYPE_LABEL[input.type],
    code,
    held: holdId !== null,
  });
  await writeAudit({
    entity: "cod_dispute",
    entityId: id,
    action: "cod.dispute_opened",
    actor,
    after: { code, type: input.type, merchantId, awb: parcel?.awb ?? null, claimAmountCents: input.claimAmountCents, holdId },
  });
  return load(id);
}

// ─────────────────────────────────────────────────────────────── work it

/** Finance picks a case up. Re-assigning is allowed; the audit shows who had it. */
export async function assignDispute(
  input: { disputeId: string; assigneeId?: string | null; assigneeName?: string | null },
  actor: Principal,
): Promise<DisputeRow> {
  const row = await load(input.disputeId);
  if (!LIVE_STATUSES.includes(row.status as DisputeStatus)) {
    errors.conflict(`${row.code} is ${row.status}; only a live case can be assigned.`, { currentStatus: row.status });
  }
  const assigneeId = input.assigneeId ?? actor.userId;
  const assigneeName = input.assigneeName ?? (assigneeId === actor.userId ? actor.name : assigneeId);
  await db
    .update(codDispute)
    .set({ status: "investigating", assignedToId: assigneeId, assignedToName: assigneeName, updatedAt: new Date() })
    .where(eq(codDispute.id, row.id));
  await writeAudit({
    entity: "cod_dispute",
    entityId: row.id,
    action: "cod.dispute_assigned",
    actor,
    before: { status: row.status, assignedToId: row.assignedToId },
    after: { status: "investigating", assignedToId: assigneeId },
  });
  return load(row.id);
}

export interface ResolveDisputeInput {
  disputeId: string;
  outcome: "upheld" | "rejected";
  /** MONEY: cents. Required > 0 when upheld with money; ≤ the claim. */
  approvedAmountCents?: number | null;
  resolution: string;
  remedy?: Remedy | null;
  /** For remedy = credit_note: an issued invoice of the same merchant. */
  invoiceId?: string | null;
  /** For remedy = bank_transfer: the UTR. */
  payoutRef?: string | null;
}

/**
 * Decide a case. Maker–checker: the person who opened it cannot decide it.
 * Upheld money is paid one of two ways and the case records which; the hold
 * the case raised is released either way, with the decision as its note.
 */
export async function resolveDispute(input: ResolveDisputeInput, actor: Principal): Promise<DisputeRow> {
  const row = await load(input.disputeId);
  if (!LIVE_STATUSES.includes(row.status as DisputeStatus)) {
    errors.conflict(`${row.code} is already ${row.status}.`, { currentStatus: row.status });
  }
  if (row.openedById === actor.userId) {
    fail(
      "FORBIDDEN",
      problem(
        "maker-checker",
        "Opener cannot decide",
        403,
        `${actor.name} opened ${row.code}; a different finance user must decide it.`,
        { openedById: row.openedById },
      ),
    );
  }
  const resolution = input.resolution.trim();
  if (resolution.length < 10) errors.badRequest("Explain the decision in at least 10 characters.");

  let approved = 0;
  let remedy: Remedy = "none";
  let creditNoteId: string | null = null;
  let invoiceId: string | null = null;
  let payoutRef: string | null = null;

  if (input.outcome === "upheld") {
    approved = input.approvedAmountCents ?? 0;
    if (!Number.isInteger(approved) || approved < 0) errors.badRequest("Approved amount must be whole cents, zero or more.");
    if (approved > row.claimAmountCents) {
      fail(
        "BAD_REQUEST",
        problem(
          "approval-exceeds-claim",
          "More than was claimed",
          422,
          `${formatLkr(approved)} is more than the ${formatLkr(row.claimAmountCents)} ${row.merchantName} claimed.`,
          { claimAmountCents: row.claimAmountCents, approvedAmountCents: approved },
        ),
      );
    }
    remedy = input.remedy ?? "none";
    if (approved > 0 && remedy === "none") {
      errors.badRequest("An upheld claim with money must say how it is paid: a credit note or a bank transfer.");
    }
    if (approved === 0 && remedy !== "none") errors.badRequest("Nothing approved, so there is nothing to pay.");

    if (remedy === "credit_note") {
      if (!input.invoiceId) errors.badRequest("Choose the issued invoice the credit note is raised against.");
      const { invoice } = await getInvoice(input.invoiceId!);
      if (invoice.merchantId !== row.merchantId) {
        errors.badRequest(`${invoice.code} belongs to another merchant.`, { invoiceId: invoice.id });
      }
      const { creditNote } = await issueCreditNote({
        invoiceId: invoice.id,
        amountCents: approved,
        reason: `${row.code} upheld: ${resolution}`.slice(0, 500),
        disputeId: row.id,
        actor,
      });
      creditNoteId = creditNote.id;
      invoiceId = invoice.id;
    }
    if (remedy === "bank_transfer") {
      payoutRef = input.payoutRef?.trim() ?? "";
      if (payoutRef.length < 6) errors.badRequest("A bank transfer needs its UTR / reference (at least 6 characters).");
    }
  } else if (input.remedy && input.remedy !== "none") {
    errors.badRequest("A rejected case pays nothing.");
  }

  const status: DisputeStatus = input.outcome === "upheld" ? "resolved" : "rejected";
  const now = new Date();
  await db
    .update(codDispute)
    .set({
      status,
      approvedAmountCents: approved,
      resolution,
      remedy,
      creditNoteId,
      invoiceId,
      payoutRef,
      resolvedById: actor.userId,
      resolvedByName: actor.name,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(codDispute.id, row.id));

  if (row.holdId) await releaseHold(row.holdId, `${row.code} ${status}: ${resolution}`, actor);

  await writeAudit({
    entity: "cod_dispute",
    entityId: row.id,
    action: input.outcome === "upheld" ? "cod.dispute_upheld" : "cod.dispute_rejected",
    actor,
    before: { status: row.status },
    after: { status, approvedAmountCents: approved, remedy, creditNoteId, payoutRef, resolution },
  });
  return load(row.id);
}

/** The merchant (or staff on its behalf) drops a case that is still live. */
export async function withdrawDispute(
  input: { disputeId: string; reason: string },
  actor: Principal,
): Promise<DisputeRow> {
  const row = await load(input.disputeId);
  assertVisible(row, actor);
  if (!LIVE_STATUSES.includes(row.status as DisputeStatus)) {
    errors.conflict(`${row.code} is already ${row.status}.`, { currentStatus: row.status });
  }
  const reason = input.reason.trim();
  if (reason.length < 5) errors.badRequest("Say why the case is withdrawn (at least 5 characters).");
  const now = new Date();
  await db
    .update(codDispute)
    .set({ status: "withdrawn", resolution: `Withdrawn: ${reason}`, resolvedById: actor.userId, resolvedByName: actor.name, resolvedAt: now, updatedAt: now })
    .where(eq(codDispute.id, row.id));
  if (row.holdId) await releaseHold(row.holdId, `${row.code} withdrawn: ${reason}`, actor);
  await writeAudit({
    entity: "cod_dispute",
    entityId: row.id,
    action: "cod.dispute_withdrawn",
    actor,
    before: { status: row.status },
    after: { status: "withdrawn", reason },
  });
  return load(row.id);
}

async function releaseHold(holdId: string, note: string, actor: Principal): Promise<void> {
  try {
    await clearHold({ holdId, note: note.slice(0, 500), actor });
  } catch (error) {
    // Already cleared by finance by hand — the case still closes.
    if ((error as { status?: number }).status !== 409) throw error;
  }
}

// ─────────────────────────────────────────────────────────────── reads

export interface ListDisputesInput {
  status?: DisputeStatus[];
  type?: DisputeType[];
  /** Restrict to the claim register (loss + damage). */
  register?: boolean;
  merchantId?: string;
  overdueOnly?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

/** Server-side paginated (§11). The caller pins merchantId for a merchant. */
export async function listDisputes(input: ListDisputesInput = {}): Promise<{ rows: DisputeRow[]; total: number }> {
  const where: SQL[] = [];
  if (input.status?.length) where.push(inArray(codDispute.status, input.status));
  if (input.type?.length) where.push(inArray(codDispute.type, input.type));
  if (input.register) where.push(inArray(codDispute.type, [...CLAIM_TYPES]));
  if (input.merchantId) where.push(eq(codDispute.merchantId, input.merchantId));
  if (input.overdueOnly) {
    where.push(inArray(codDispute.status, [...LIVE_STATUSES]));
    where.push(lt(codDispute.slaDueAt, new Date()));
  }
  if (input.q?.trim()) {
    const q = `%${input.q.trim().toUpperCase()}%`;
    where.push(or(like(sql`upper(${codDispute.code})`, q), like(sql`upper(${codDispute.awb})`, q), like(sql`upper(${codDispute.merchantName})`, q))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const [{ total }] = (await db.select({ total: count() }).from(codDispute).where(cond)) as [{ total: number }];
  const rows = await db
    .select()
    .from(codDispute)
    .where(cond)
    .orderBy(desc(codDispute.createdAt))
    .limit(Math.min(input.limit ?? 50, 200))
    .offset(input.offset ?? 0);
  return { rows, total };
}

export async function getDispute(id: string, actor: Principal): Promise<DisputeRow> {
  const row = await load(id);
  assertVisible(row, actor);
  return row;
}

/**
 * Queue and register headline numbers. MONEY in cents. `paid` is what upheld
 * cases actually paid out, split by how.
 */
export async function disputeCounts(merchantId?: string): Promise<{
  open: number;
  investigating: number;
  overdue: number;
  register: { live: number; claimedCents: number; approvedCents: number; paidCreditNoteCents: number; paidBankCents: number };
}> {
  const rows = await db
    .select()
    .from(codDispute)
    .where(merchantId ? eq(codDispute.merchantId, merchantId) : undefined);
  const now = Date.now();
  const live = (r: DisputeRow) => LIVE_STATUSES.includes(r.status as DisputeStatus);
  const claims = rows.filter((r) => CLAIM_TYPES.includes(r.type as DisputeType));
  const sum = (xs: DisputeRow[], f: (r: DisputeRow) => number) => xs.reduce((s, r) => s + f(r), 0);
  return {
    open: rows.filter((r) => r.status === "open").length,
    investigating: rows.filter((r) => r.status === "investigating").length,
    overdue: rows.filter((r) => live(r) && r.slaDueAt && r.slaDueAt.getTime() < now).length,
    register: {
      live: claims.filter(live).length,
      claimedCents: sum(claims, (r) => r.claimAmountCents),
      approvedCents: sum(claims, (r) => r.approvedAmountCents ?? 0),
      paidCreditNoteCents: sum(claims.filter((r) => r.remedy === "credit_note"), (r) => r.approvedAmountCents ?? 0),
      paidBankCents: sum(claims.filter((r) => r.remedy === "bank_transfer"), (r) => r.approvedAmountCents ?? 0),
    },
  };
}
