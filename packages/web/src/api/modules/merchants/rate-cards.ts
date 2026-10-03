import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import {
  merchant,
  rateBand,
  rateCard,
  rateCardVersion,
  rateSlab,
  rateSurcharge,
} from "../../database/schema/merchants";
import { errors, isUniqueViolationOn } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import {
  PricingError,
  quote,
  tariffProblems,
  type PricingBand,
  type PricingSlab,
  type PricingSurcharge,
  type QuoteInput,
} from "./pricing";

/**
 * MODULE: merchants — rate cards (§3 puts tariffs in the merchants module).
 *
 * §15 q3 is OPEN. Everything here is a configurable engine; the seeded card is
 * `placeholder = true` and every API response carries that flag so no screen
 * can show a placeholder price without saying so.
 *
 * Versioning: draft → active → superseded. Only a draft is edited (as a whole
 * document: bands, slabs and surcharges are replaced together, atomically, in
 * one batch). Publishing supersedes the family's current active version in the
 * same batch, so a family never has two active versions or none mid-publish.
 */

export const PLACEHOLDER_CARD_CODE = "PILOT-PLACEHOLDER";

export type RateCardRow = typeof rateCard.$inferSelect;
export type RateCardVersionRow = typeof rateCardVersion.$inferSelect;

export interface TariffDocument {
  volumetricDivisor: number;
  roundingGrams: number;
  note: string | null;
  bands: PricingBand[];
  slabs: PricingSlab[];
  surcharges: PricingSurcharge[];
}

async function versionChildren(versionId: string) {
  const [bands, slabs, surcharges] = await Promise.all([
    db.select().from(rateBand).where(eq(rateBand.versionId, versionId)).orderBy(asc(rateBand.band)),
    db
      .select()
      .from(rateSlab)
      .where(eq(rateSlab.versionId, versionId))
      .orderBy(asc(rateSlab.band), asc(rateSlab.maxGrams)),
    db.select().from(rateSurcharge).where(eq(rateSurcharge.versionId, versionId)).orderBy(asc(rateSurcharge.code)),
  ]);
  return {
    bands: bands.map((b) => ({ band: b.band, label: b.label, extraPerKgCents: b.extraPerKgCents })),
    slabs: slabs.map((s) => ({ band: s.band, maxGrams: s.maxGrams, priceCents: s.priceCents })),
    surcharges: surcharges.map((s) => ({
      code: s.code,
      label: s.label,
      kind: s.kind as PricingSurcharge["kind"],
      amount: s.amount,
      mode: s.mode as PricingSurcharge["mode"],
    })),
  };
}

async function cardOrThrow(id: string): Promise<RateCardRow> {
  const [row] = await db.select().from(rateCard).where(eq(rateCard.id, id));
  if (!row) errors.notFound("Rate card");
  return row!;
}

async function versionOrThrow(id: string): Promise<RateCardVersionRow> {
  const [row] = await db.select().from(rateCardVersion).where(eq(rateCardVersion.id, id));
  if (!row) errors.notFound("Rate card version");
  return row!;
}

export async function activeVersionOf(cardId: string): Promise<RateCardVersionRow | null> {
  const [row] = await db
    .select()
    .from(rateCardVersion)
    .where(and(eq(rateCardVersion.rateCardId, cardId), eq(rateCardVersion.status, "active")));
  return row ?? null;
}

export async function listRateCards() {
  const cards = await db.select().from(rateCard).orderBy(asc(rateCard.code));
  const versions = cards.length
    ? await db
        .select()
        .from(rateCardVersion)
        .where(inArray(rateCardVersion.rateCardId, cards.map((c) => c.id)))
    : [];
  const usage = await db
    .select({ rateCardId: merchant.rateCardId, n: count() })
    .from(merchant)
    .groupBy(merchant.rateCardId);
  return cards.map((c) => {
    const own = versions.filter((v) => v.rateCardId === c.id);
    const active = own.find((v) => v.status === "active") ?? null;
    const draft = own.find((v) => v.status === "draft") ?? null;
    return {
      ...c,
      activeVersion: active ? { id: active.id, version: active.version, activatedAt: active.activatedAt } : null,
      draftVersion: draft ? { id: draft.id, version: draft.version, updatedAt: draft.updatedAt } : null,
      versionCount: own.length,
      merchantCount: Number(usage.find((u) => u.rateCardId === c.id)?.n ?? 0),
    };
  });
}

export async function getRateCard(id: string) {
  const card = await cardOrThrow(id);
  const versions = await db
    .select()
    .from(rateCardVersion)
    .where(eq(rateCardVersion.rateCardId, id))
    .orderBy(desc(rateCardVersion.version));
  const merchants = await db
    .select({ id: merchant.id, name: merchant.name, status: merchant.status })
    .from(merchant)
    .where(eq(merchant.rateCardId, id))
    .orderBy(asc(merchant.name));
  return { card, versions, merchants };
}

export async function getVersion(versionId: string) {
  const version = await versionOrThrow(versionId);
  const card = await cardOrThrow(version.rateCardId);
  return { card, version, ...(await versionChildren(versionId)) };
}

function childRows(versionId: string, doc: TariffDocument) {
  return {
    bands: doc.bands.map((b) => ({ id: prefixedId("rbd"), versionId, ...b })),
    slabs: doc.slabs.map((s) => ({ id: prefixedId("rsl"), versionId, ...s })),
    surcharges: doc.surcharges.map((s) => ({ id: prefixedId("rsc"), versionId, ...s })),
  };
}

/** A starting document: two bands, no prices. Nothing is invented. */
const EMPTY_DOC: TariffDocument = {
  volumetricDivisor: 5000,
  roundingGrams: 500,
  note: null,
  bands: [
    { band: "local", label: "Within the origin branch", extraPerKgCents: 0 },
    { band: "outstation", label: "To another branch", extraPerKgCents: 0 },
  ],
  slabs: [],
  surcharges: [],
};

export async function createRateCard(input: { code: string; name: string; placeholder: boolean; actorName: string }) {
  const id = prefixedId("rtc");
  const versionId = prefixedId("rcv");
  const now = new Date();
  const children = childRows(versionId, EMPTY_DOC);
  try {
    await db.batch([
      db.insert(rateCard).values({ id, code: input.code.trim().toUpperCase(), name: input.name.trim(), placeholder: input.placeholder }),
      db.insert(rateCardVersion).values({
        id: versionId,
        rateCardId: id,
        version: 1,
        status: "draft",
        volumetricDivisor: EMPTY_DOC.volumetricDivisor,
        roundingGrams: EMPTY_DOC.roundingGrams,
        updatedAt: now,
        updatedByName: input.actorName,
      }),
      db.insert(rateBand).values(children.bands),
    ]);
  } catch (error) {
    if (isUniqueViolationOn(error, "code")) errors.conflict(`A rate card with code ${input.code.toUpperCase()} already exists.`);
    throw error;
  }
  return { card: await cardOrThrow(id), versionId };
}

export async function renameRateCard(id: string, patch: { name?: string; placeholder?: boolean }) {
  const before = await cardOrThrow(id);
  const next: Partial<typeof rateCard.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.placeholder !== undefined) next.placeholder = patch.placeholder;
  if (Object.keys(next).length === 0) return { before, after: before };
  const [after] = await db.update(rateCard).set(next).where(eq(rateCard.id, id)).returning();
  return { before, after: after! };
}

/** Open a new draft, copied from the active version (or empty if none). One draft per family. */
export async function newDraft(cardId: string, actorName: string) {
  await cardOrThrow(cardId);
  const versions = await db.select().from(rateCardVersion).where(eq(rateCardVersion.rateCardId, cardId));
  const existing = versions.find((v) => v.status === "draft");
  if (existing) errors.conflict(`Version ${existing.version} is already a draft — edit or discard it first.`, { versionId: existing.id });
  const active = versions.find((v) => v.status === "active");
  const doc: TariffDocument = active
    ? {
        volumetricDivisor: active.volumetricDivisor,
        roundingGrams: active.roundingGrams,
        note: active.note,
        ...(await versionChildren(active.id)),
      }
    : EMPTY_DOC;
  const versionId = prefixedId("rcv");
  const version = Math.max(0, ...versions.map((v) => v.version)) + 1;
  const children = childRows(versionId, doc);
  await db.batch([
    db.insert(rateCardVersion).values({
      id: versionId,
      rateCardId: cardId,
      version,
      status: "draft",
      volumetricDivisor: doc.volumetricDivisor,
      roundingGrams: doc.roundingGrams,
      note: doc.note,
      updatedAt: new Date(),
      updatedByName: actorName,
    }),
    ...(children.bands.length ? [db.insert(rateBand).values(children.bands)] : []),
    ...(children.slabs.length ? [db.insert(rateSlab).values(children.slabs)] : []),
    ...(children.surcharges.length ? [db.insert(rateSurcharge).values(children.surcharges)] : []),
  ] as unknown as Parameters<typeof db.batch>[0]);
  return getVersion(versionId);
}

/** Replace a draft's whole document. Active and superseded versions are frozen. */
export async function saveDraft(versionId: string, doc: TariffDocument, actorName: string) {
  const v = await versionOrThrow(versionId);
  if (v.status !== "draft") errors.conflict(`Version ${v.version} is ${v.status} and frozen. Open a new draft to change prices.`);
  const children = childRows(versionId, doc);
  await db.batch([
    db.delete(rateBand).where(eq(rateBand.versionId, versionId)),
    db.delete(rateSlab).where(eq(rateSlab.versionId, versionId)),
    db.delete(rateSurcharge).where(eq(rateSurcharge.versionId, versionId)),
    db
      .update(rateCardVersion)
      .set({
        volumetricDivisor: doc.volumetricDivisor,
        roundingGrams: doc.roundingGrams,
        note: doc.note,
        updatedAt: new Date(),
        updatedByName: actorName,
      })
      .where(eq(rateCardVersion.id, versionId)),
    ...(children.bands.length ? [db.insert(rateBand).values(children.bands)] : []),
    ...(children.slabs.length ? [db.insert(rateSlab).values(children.slabs)] : []),
    ...(children.surcharges.length ? [db.insert(rateSurcharge).values(children.surcharges)] : []),
  ] as unknown as Parameters<typeof db.batch>[0]);
  const saved = await getVersion(versionId);
  return { ...saved, problems: tariffProblems(saved.version, saved.bands, saved.slabs, saved.surcharges) };
}

export async function publishDraft(versionId: string, actorName: string) {
  const v = await versionOrThrow(versionId);
  if (v.status !== "draft") errors.conflict(`Version ${v.version} is ${v.status}; only a draft can be published.`);
  const children = await versionChildren(versionId);
  const problems = tariffProblems(v, children.bands, children.slabs, children.surcharges);
  if (problems.length) errors.badRequest(`This draft cannot be published: ${problems[0]}`, { problems });
  const previous = await activeVersionOf(v.rateCardId);
  const now = new Date();
  await db.batch([
    db
      .update(rateCardVersion)
      .set({ status: "superseded", updatedAt: now })
      .where(and(eq(rateCardVersion.rateCardId, v.rateCardId), eq(rateCardVersion.status, "active"))),
    db
      .update(rateCardVersion)
      .set({ status: "active", activatedAt: now, updatedAt: now, updatedByName: actorName })
      .where(eq(rateCardVersion.id, versionId)),
  ]);
  return { versionId, version: v.version, superseded: previous ? { id: previous.id, version: previous.version } : null };
}

export async function discardDraft(versionId: string) {
  const v = await versionOrThrow(versionId);
  if (v.status !== "draft") errors.conflict(`Version ${v.version} is ${v.status}; only a draft can be discarded.`);
  await db.batch([
    db.delete(rateBand).where(eq(rateBand.versionId, versionId)),
    db.delete(rateSlab).where(eq(rateSlab.versionId, versionId)),
    db.delete(rateSurcharge).where(eq(rateSurcharge.versionId, versionId)),
    db.delete(rateCardVersion).where(eq(rateCardVersion.id, versionId)),
  ]);
  return { versionId, version: v.version, discarded: true };
}

/** Price a parcel against a specific version (preview — drafts included). */
export async function quoteVersion(versionId: string, input: QuoteInput) {
  const { card, version, bands, slabs, surcharges } = await getVersion(versionId);
  try {
    return {
      rateCard: { id: card.id, code: card.code, name: card.name, placeholder: card.placeholder },
      version: { id: version.id, version: version.version, status: version.status },
      ...quote(version, bands, slabs, surcharges, input),
    };
  } catch (error) {
    if (error instanceof PricingError) errors.badRequest(error.message);
    throw error;
  }
}

/** Price a parcel for a merchant: its family's ACTIVE version. */
export async function quoteForMerchant(merchantId: string, input: QuoteInput) {
  const [m] = await db.select().from(merchant).where(eq(merchant.id, merchantId));
  if (!m) errors.notFound("Merchant");
  if (!m!.rateCardId) errors.conflict(`${m!.name} has no rate card assigned.`, { merchantId });
  const active = await activeVersionOf(m!.rateCardId!);
  if (!active) errors.conflict("The merchant's rate card has no published version.");
  return quoteVersion(active!.id, input);
}

export async function assignRateCard(merchantId: string, rateCardId: string | null) {
  const [m] = await db.select().from(merchant).where(eq(merchant.id, merchantId));
  if (!m) errors.notFound("Merchant");
  if (rateCardId) {
    await cardOrThrow(rateCardId);
    if (!(await activeVersionOf(rateCardId))) {
      errors.conflict("Publish a version of this rate card before assigning it to a merchant.");
    }
  }
  await db.update(merchant).set({ rateCardId }).where(eq(merchant.id, merchantId));
  return { merchantId, before: m!.rateCardId, after: rateCardId };
}

/**
 * Seed the pilot placeholder tariff (idempotent). Every number is illustrative
 * and the card is flagged placeholder — §15 q3 is unanswered.
 */
export async function seedPlaceholderRateCard(): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select().from(rateCard).where(eq(rateCard.code, PLACEHOLDER_CARD_CODE));
  if (existing) return { id: existing.id, created: false };
  const id = "rtc_pilot_placeholder";
  const versionId = "rcv_pilot_placeholder_v1";
  const doc: TariffDocument = {
    volumetricDivisor: 5000,
    roundingGrams: 500,
    note: "PLACEHOLDER — illustrative numbers only. §15 q3 (zones, weight slabs, surcharges) is unanswered; replace before billing anyone.",
    bands: [
      { band: "local", label: "Within the origin branch", extraPerKgCents: 10_000 },
      { band: "outstation", label: "To another branch", extraPerKgCents: 15_000 },
    ],
    slabs: [
      { band: "local", maxGrams: 1000, priceCents: 35_000 },
      { band: "local", maxGrams: 2000, priceCents: 45_000 },
      { band: "local", maxGrams: 5000, priceCents: 70_000 },
      { band: "outstation", maxGrams: 1000, priceCents: 45_000 },
      { band: "outstation", maxGrams: 2000, priceCents: 55_000 },
      { band: "outstation", maxGrams: 5000, priceCents: 90_000 },
    ],
    surcharges: [
      { code: "fragile", label: "Fragile handling (placeholder)", kind: "flat", amount: 10_000, mode: "on_request" },
    ],
  };
  const children = childRows(versionId, doc);
  const now = new Date();
  await db.batch([
    db.insert(rateCard).values({ id, code: PLACEHOLDER_CARD_CODE, name: "Pilot placeholder tariff (NOT client-approved)", placeholder: true }),
    db.insert(rateCardVersion).values({
      id: versionId,
      rateCardId: id,
      version: 1,
      status: "active",
      volumetricDivisor: doc.volumetricDivisor,
      roundingGrams: doc.roundingGrams,
      note: doc.note,
      activatedAt: now,
      updatedAt: now,
      updatedByName: "seed",
    }),
    db.insert(rateBand).values(children.bands),
    db.insert(rateSlab).values(children.slabs),
    db.insert(rateSurcharge).values(children.surcharges),
  ]);
  return { id, created: true };
}
