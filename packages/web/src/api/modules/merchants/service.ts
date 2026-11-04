import { and, count, desc, eq, inArray, like, lte, or } from "drizzle-orm";
import { db } from "../../database";
import { merchant, merchantRegistrationCooldown, merchantRegistrationRequest } from "../../database/schema/merchants";
import { prefixedId } from "../../shared/ulid";
import { errors, isUniqueViolationOn } from "../../shared/errors";
import { isGlobalScope, type Principal } from "../../shared/auth";
import type { DbTransaction } from "../../database/transaction";
import { enqueue } from "../../shared/outbox";

/**
 * MODULE: merchants. The ONLY file that reads merchants_* tables (§4).
 */

export type MerchantRow = typeof merchant.$inferSelect;
export type MerchantRegistrationRequestRow = typeof merchantRegistrationRequest.$inferSelect;

const REGISTRATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface MerchantRegistrationInput {
  submissionId: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  district: string;
  businessType: string;
  monthlyVolume: string;
  notes: string;
  smsConsent: true;
}

export type RegistrationSmsStage = "receipt" | "confirmation";

function publicRegistrationRow(row: MerchantRegistrationRequestRow) {
  return {
    id: row.id,
    businessName: row.businessName,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    district: row.district,
    businessType: row.businessType,
    monthlyVolume: row.monthlyVolume,
    notes: row.notes,
    status: row.status as "new" | "converted",
    merchantId: row.merchantId,
    createdAt: row.createdAt,
    convertedAt: row.convertedAt,
    receiptSmsState: row.receiptSmsState,
    confirmationSmsState: row.confirmationSmsState,
    smsConsent: row.smsConsent,
  };
}

function scopeFilter(scope: Principal) {
  if (isGlobalScope(scope.role)) return undefined;
  if (scope.role === "merchant") return eq(merchant.id, scope.merchantId ?? "__none__");
  return eq(merchant.branchId, scope.branchId);
}

export async function getMerchant(id: string): Promise<MerchantRow | null> {
  const [row] = await db.select().from(merchant).where(eq(merchant.id, id));
  return row ?? null;
}

export async function getMerchantScoped(
  id: string,
  scope: Principal,
): Promise<MerchantRow> {
  const row = await getMerchant(id);
  if (!row) errors.notFound("Merchant");
  if (!isGlobalScope(scope.role)) {
    if (scope.role === "merchant" && row!.id !== scope.merchantId) {
      errors.notFound("Merchant");
    }
    if (scope.role !== "merchant" && row!.branchId !== scope.branchId) {
      errors.forbidden("This merchant belongs to another branch.");
    }
  }
  return row!;
}

export async function listMerchants(
  input: { page: number; pageSize: number; search?: string },
  scope: Principal,
) {
  const filters = [scopeFilter(scope)];
  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    filters.push(or(like(merchant.name, term), like(merchant.contactPhone, term)));
  }
  const where = and(...filters.filter((f) => f !== undefined));
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const offset = (Math.max(input.page, 1) - 1) * pageSize;

  const [rows, [total]] = await Promise.all([
    db.select().from(merchant).where(where).limit(pageSize).offset(offset),
    db.select({ value: count() }).from(merchant).where(where),
  ]);

  return { rows, total: total?.value ?? 0, page: Math.max(input.page, 1), pageSize };
}

/** Every merchant in the caller's scope, for pickers and dropdowns. */
export async function merchantOptions(scope: Principal) {
  return db
    .select({ id: merchant.id, name: merchant.name, codEnabled: merchant.codEnabled, status: merchant.status })
    .from(merchant)
    .where(scopeFilter(scope));
}

export interface CreateMerchantInput {
  name: string;
  branchId: string;
  pickupRiderId?: string | null;
  vatNo?: string | null;
  address: string;
  lat?: number | null;
  lng?: number | null;
  contactName: string;
  contactPhone: string;
  codEnabled: boolean;
  /** signature | otp | photo — enforced from M3, recorded from M1. */
  podPolicy: string;
}

export async function createMerchant(
  input: CreateMerchantInput,
  actor: Principal,
  executor: DbTransaction | typeof db = db,
): Promise<MerchantRow> {
  // Ops may only create merchants inside their own branch (§5).
  const branchId = isGlobalScope(actor.role) ? input.branchId : actor.branchId;

  const [row] = await executor
    .insert(merchant)
    .values({
      id: prefixedId("mch"),
      branchId,
      pickupRiderId: input.pickupRiderId ?? null,
      name: input.name.trim(),
      vatNo: input.vatNo?.trim() || null,
      address: input.address.trim(),
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      contactName: input.contactName.trim(),
      contactPhone: input.contactPhone.trim(),
      codEnabled: input.codEnabled,
      podPolicy: input.podPolicy,
      status: "active",
    })
    .returning();
  return row!;
}

/** Create once by persistent submission UUID and atomically enforce the phone cooldown. */
export async function createRegistrationRequest(
  input: MerchantRegistrationInput,
  beforeCreate?: (executor: DbTransaction) => Promise<void>,
  now = new Date(),
): Promise<"created" | "duplicate" | "cooldown"> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: merchantRegistrationRequest.id })
        .from(merchantRegistrationRequest)
        .where(eq(merchantRegistrationRequest.submissionId, input.submissionId))
        .limit(1);
      if (existing) return "duplicate";

      const cooldownUntil = new Date(now.getTime() + REGISTRATION_COOLDOWN_MS);
      const claimed = await tx
        .insert(merchantRegistrationCooldown)
        .values({ phone: input.phone, cooldownUntil })
        .onConflictDoUpdate({
          target: merchantRegistrationCooldown.phone,
          set: { cooldownUntil },
          setWhere: lte(merchantRegistrationCooldown.cooldownUntil, now),
        })
        .returning({ phone: merchantRegistrationCooldown.phone });
      if (claimed.length === 0) return "cooldown";
      if (beforeCreate) await beforeCreate(tx);

      const requestId = prefixedId("mrr");
      await tx.insert(merchantRegistrationRequest).values({
        id: requestId,
        submissionId: input.submissionId,
        businessName: input.businessName,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email,
        district: input.district,
        businessType: input.businessType,
        monthlyVolume: input.monthlyVolume,
        notes: input.notes,
        status: "new",
        merchantId: null,
        createdAt: now,
        convertedAt: null,
        receiptSmsState: "queued",
        confirmationSmsState: "not_queued",
        smsConsent: true,
      });
      await enqueue("merchant_registration.sms", { registrationRequestId: requestId, stage: "receipt" }, tx);
      return "created";
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "merchants_registration_request.submission_id")) {
      const [existing] = await db
        .select({ id: merchantRegistrationRequest.id })
        .from(merchantRegistrationRequest)
        .where(eq(merchantRegistrationRequest.submissionId, input.submissionId))
        .limit(1);
      if (existing) return "duplicate";
    }
    throw error;
  }
}

/** Admin-only queue query. The internal submission UUID is never returned. */
export async function listRegistrationRequests(input: {
  page: number;
  pageSize: number;
  status?: "new" | "converted";
}) {
  const page = Math.max(1, input.page);
  const pageSize = Math.min(100, Math.max(1, input.pageSize));
  const where = input.status ? eq(merchantRegistrationRequest.status, input.status) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(merchantRegistrationRequest)
      .where(where)
      .orderBy(desc(merchantRegistrationRequest.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(merchantRegistrationRequest).where(where),
  ]);
  return { rows: rows.map(publicRegistrationRow), total: total?.value ?? 0, page, pageSize };
}

export async function registrationRequestCount(): Promise<{ newCount: number }> {
  const [row] = await db
    .select({ value: count() })
    .from(merchantRegistrationRequest)
    .where(eq(merchantRegistrationRequest.status, "new"));
  return { newCount: row?.value ?? 0 };
}

export async function getRegistrationRequest(id: string) {
  const [row] = await db
    .select()
    .from(merchantRegistrationRequest)
    .where(eq(merchantRegistrationRequest.id, id))
    .limit(1);
  if (!row) errors.notFound("Merchant registration request");
  return publicRegistrationRow(row!);
}

/** Internal lookup and state transitions used only by the SMS worker. */
export async function getRegistrationRequestForWorker(id: string) {
  const [row] = await db
    .select()
    .from(merchantRegistrationRequest)
    .where(eq(merchantRegistrationRequest.id, id))
    .limit(1);
  return row ?? null;
}

export async function claimRegistrationSms(id: string, stage: RegistrationSmsStage) {
  const stateColumn = stage === "receipt"
    ? merchantRegistrationRequest.receiptSmsState
    : merchantRegistrationRequest.confirmationSmsState;
  const conditions = [
    eq(merchantRegistrationRequest.id, id),
    eq(merchantRegistrationRequest.smsConsent, true),
    inArray(stateColumn, ["queued", "failed"]),
    ...(stage === "confirmation" ? [eq(merchantRegistrationRequest.status, "converted")] : []),
  ];
  const [row] = await db
    .update(merchantRegistrationRequest)
    .set(stage === "receipt" ? { receiptSmsState: "sending" } : { confirmationSmsState: "sending" })
    .where(and(...conditions))
    .returning({ id: merchantRegistrationRequest.id, phone: merchantRegistrationRequest.phone });
  return row ?? null;
}

export async function setRegistrationSmsState(
  id: string,
  stage: RegistrationSmsStage,
  state: string,
): Promise<void> {
  await db
    .update(merchantRegistrationRequest)
    .set(stage === "receipt" ? { receiptSmsState: state } : { confirmationSmsState: state })
    .where(eq(merchantRegistrationRequest.id, id));
}

/** Link once and enqueue acceptance in the same merchant-onboarding transaction. */
export async function convertRegistrationRequest(
  id: string,
  merchantId: string,
  executor: DbTransaction | typeof db = db,
  now = new Date(),
): Promise<void> {
  const [updated] = await executor
    .update(merchantRegistrationRequest)
    .set({ status: "converted", merchantId, convertedAt: now, confirmationSmsState: "queued" })
    .where(and(eq(merchantRegistrationRequest.id, id), eq(merchantRegistrationRequest.status, "new")))
    .returning({ id: merchantRegistrationRequest.id });
  if (!updated) errors.conflict("This registration request has already been converted or is unavailable.");
  await enqueue("merchant_registration.sms", { registrationRequestId: id, stage: "confirmation" }, executor);
}

export async function setMerchantStatus(
  id: string,
  status: "active" | "suspended",
  scope: Principal,
): Promise<MerchantRow> {
  await getMerchantScoped(id, scope);
  const [row] = await db
    .update(merchant)
    .set({ status })
    .where(eq(merchant.id, id))
    .returning();
  return row!;
}

export interface MerchantPatch {
  name?: string;
  branchId?: string;
  pickupRiderId?: string | null;
  vatNo?: string | null;
  address?: string;
  contactName?: string;
  contactPhone?: string;
  codEnabled?: boolean;
  podPolicy?: "signature" | "otp" | "photo";
}

/**
 * Edit a merchant (§10 M5 merchant onboarding). Ops edits inside its own
 * branch and cannot move a merchant to another branch; admin can.
 */
export async function updateMerchant(
  id: string,
  patch: MerchantPatch,
  scope: Principal,
): Promise<{ before: MerchantRow; after: MerchantRow }> {
  const before = await getMerchantScoped(id, scope);
  if (patch.branchId !== undefined && patch.branchId !== before.branchId && !isGlobalScope(scope.role)) {
    errors.forbidden("Only an admin can move a merchant to another branch.");
  }
  const next: Partial<typeof merchant.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.branchId !== undefined) next.branchId = patch.branchId;
  if (patch.pickupRiderId !== undefined) next.pickupRiderId = patch.pickupRiderId;
  if (patch.vatNo !== undefined) next.vatNo = patch.vatNo?.trim() || null;
  if (patch.address !== undefined) next.address = patch.address.trim();
  if (patch.contactName !== undefined) next.contactName = patch.contactName.trim();
  if (patch.contactPhone !== undefined) next.contactPhone = patch.contactPhone.trim();
  if (patch.codEnabled !== undefined) next.codEnabled = patch.codEnabled;
  if (patch.podPolicy !== undefined) next.podPolicy = patch.podPolicy;
  if (Object.keys(next).length === 0) return { before, after: before };
  const [after] = await db.update(merchant).set(next).where(eq(merchant.id, id)).returning();
  return { before, after: after! };
}

/** Merchants per account status — the admin dashboard tile. */
export async function merchantStatusCounts(): Promise<{ status: string; count: number }[]> {
  const rows = await db
    .select({ status: merchant.status, value: count() })
    .from(merchant)
    .groupBy(merchant.status);
  return rows.map((r) => ({ status: r.status, count: r.value }));
}

/** Names for a handful of merchant ids — the admin dashboard's leaderboard. */
export async function merchantNames(ids: string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return db.select({ id: merchant.id, name: merchant.name }).from(merchant).where(inArray(merchant.id, ids));
}

export async function merchantCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(merchant);
  return row?.value ?? 0;
}

/** Seed-only insert with a fixed id so parcels can reference it deterministically. */
export async function seedMerchant(
  input: CreateMerchantInput & { id: string },
): Promise<MerchantRow> {
  const [row] = await db
    .insert(merchant)
    .values({
      id: input.id,
      branchId: input.branchId,
      pickupRiderId: input.pickupRiderId ?? null,
      name: input.name,
      vatNo: input.vatNo ?? null,
      address: input.address,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      codEnabled: input.codEnabled,
      podPolicy: input.podPolicy,
      status: "active",
    })
    .returning();
  return row!;
}
