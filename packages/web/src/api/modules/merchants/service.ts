import { and, count, eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../database";
import { merchant } from "../../database/schema/merchants";
import { prefixedId } from "../../shared/ulid";
import { errors } from "../../shared/errors";
import { isGlobalScope, type Principal } from "../../shared/auth";

/**
 * MODULE: merchants. The ONLY file that reads merchants_* tables (§4).
 */

export type MerchantRow = typeof merchant.$inferSelect;

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
): Promise<MerchantRow> {
  // Ops may only create merchants inside their own branch (§5).
  const branchId = isGlobalScope(actor.role) ? input.branchId : actor.branchId;

  const [row] = await db
    .insert(merchant)
    .values({
      id: prefixedId("mch"),
      branchId,
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
