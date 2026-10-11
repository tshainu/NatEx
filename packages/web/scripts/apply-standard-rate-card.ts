import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/api/database";
import { branch } from "../src/api/database/schema/identity";
import { auditLog } from "../src/api/database/schema/shared";
import {
  merchant,
  rateBand,
  rateCard,
  rateCardVersion,
  rateSlab,
} from "../src/api/database/schema/merchants";
import * as identityService from "../src/api/modules/identity/service";
import * as rateCardService from "../src/api/modules/merchants/rate-cards";
import {
  NATEX_STANDARD_CARD_CODE,
  NATEX_STANDARD_CARD_NAME,
  natexStandardTariffDocument,
} from "../src/api/modules/merchants/standard-tariff";
import { MAX_ACCEPTED_WEIGHT_GRAMS, tariffProblems } from "../src/api/modules/merchants/pricing";
import type { TariffDocument } from "../src/api/modules/merchants/rate-cards";
import { prefixedId } from "../src/api/shared/ulid";
import { auditValues } from "../src/api/shared/audit";

const args = process.argv.slice(2);
const target = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
const apply = args.includes("--apply");
const printFingerprint = args.includes("--print-database-fingerprint");
const expectedFingerprint = args
  .find((arg) => arg.startsWith("--expected-database-sha256="))
  ?.slice("--expected-database-sha256=".length)
  .toLowerCase();
const knownArgs = new Set([
  "--apply",
  "--confirm-production",
  "--confirm-demo",
  "--print-database-fingerprint",
  "--target=production",
  "--target=demo",
  "--target=local-test",
]);
const unknownArgs = args.filter(
  (arg) => !knownArgs.has(arg) && !arg.startsWith("--expected-database-sha256="),
);
if (unknownArgs.length) throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
if (!target || !["production", "demo", "local-test"].includes(target)) {
  throw new Error("Choose --target=production, --target=demo or --target=local-test.");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set in the target service environment.");
if (target === "local-test" && !databaseUrl.startsWith("file:")) {
  throw new Error("--target=local-test only accepts a file: SQLite DATABASE_URL.");
}
if (target !== "local-test" && databaseUrl.startsWith("file:")) {
  throw new Error("Production/demo targets cannot use a file: SQLite DATABASE_URL.");
}
const databaseFingerprint = createHash("sha256")
  .update(databaseUrl)
  .update("\0")
  .update(process.env.DATABASE_AUTH_TOKEN ?? "")
  .digest("hex");
if (printFingerprint) {
  if (apply) throw new Error("--print-database-fingerprint cannot be combined with --apply.");
  console.log(JSON.stringify({ target, databaseFingerprint, databaseUrlPrinted: false }, null, 2));
  process.exit(0);
}
if (apply && target === "production" && !args.includes("--confirm-production")) {
  throw new Error("Applying to production also requires --confirm-production.");
}
if (apply && target === "demo" && !args.includes("--confirm-demo")) {
  throw new Error("Applying to demo also requires --confirm-demo.");
}
if (target !== "production" && args.includes("--confirm-production")) {
  throw new Error("--confirm-production is only valid with --target=production.");
}
if (target !== "demo" && args.includes("--confirm-demo")) {
  throw new Error("--confirm-demo is only valid with --target=demo.");
}
if (apply && target !== "local-test") {
  if (!expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new Error("Live applies require --expected-database-sha256=<verified 64-character fingerprint>.");
  }
  if (expectedFingerprint !== databaseFingerprint) {
    throw new Error(`Configured database fingerprint does not match the independently verified ${target} fingerprint.`);
  }
}

const REQUEST_ID = `natex-standard-tariff-2026-10-11-${target}`;
const RECORDED_BY = "NatEx standard tariff setup (owner-confirmed defaults, 2026-10-11)";
const PUBLISH_REASON = "Owner-confirmed standard tariff and 30 kg chargeable-weight limit, 2026-10-11.";

function canonical(document: TariffDocument): string {
  return JSON.stringify({
    volumetricDivisor: document.volumetricDivisor,
    roundingGrams: document.roundingGrams,
    note: document.note,
    bands: [...document.bands]
      .map(({ band, label, extraPerKgCents }) => ({ band, label, extraPerKgCents }))
      .sort((a, b) => a.band.localeCompare(b.band)),
    slabs: [...document.slabs]
      .map(({ band, maxGrams, priceCents }) => ({ band, maxGrams, priceCents }))
      .sort((a, b) => a.band.localeCompare(b.band) || a.maxGrams - b.maxGrams),
    surcharges: [...document.surcharges]
      .map(({ code, label, kind, amount, mode }) => ({ code, label, kind, amount, mode }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  });
}

async function documentForVersion(versionId: string): Promise<TariffDocument> {
  const saved = await rateCardService.getVersion(versionId);
  return {
    volumetricDivisor: saved.version.volumetricDivisor,
    roundingGrams: saved.version.roundingGrams,
    note: saved.version.note,
    bands: saved.bands.map(({ band, label, extraPerKgCents }) => ({ band, label, extraPerKgCents })),
    slabs: saved.slabs.map(({ band, maxGrams, priceCents }) => ({ band, maxGrams, priceCents })),
    surcharges: saved.surcharges.map(({ code, label, kind, amount, mode }) => ({ code, label, kind, amount, mode })),
  };
}

async function main() {
  const expected = natexStandardTariffDocument();
  const problems = tariffProblems(
    { volumetricDivisor: expected.volumetricDivisor, roundingGrams: expected.roundingGrams },
    expected.bands,
    expected.slabs,
    expected.surcharges,
  );
  if (problems.length) throw new Error(`The standard tariff definition is invalid: ${problems.join("; ")}`);
  if (expected.slabs.some((slab) => slab.maxGrams > MAX_ACCEPTED_WEIGHT_GRAMS)) {
    throw new Error("The standard tariff contains a slab above the accepted 30 kg limit.");
  }

  const [existingCard] = await db.select().from(rateCard).where(eq(rateCard.code, NATEX_STANDARD_CARD_CODE));
  const allMerchants = await db.select({ id: merchant.id, rateCardId: merchant.rateCardId }).from(merchant);
  const allBranches = await identityService.listBranches();
  const allCards = await db.select({ id: rateCard.id, placeholder: rateCard.placeholder }).from(rateCard);
  const placeholderIds = new Set(allCards.filter((card) => card.placeholder).map((card) => card.id));

  const merchantConflicts = allMerchants.filter(
    (row) => row.rateCardId !== null && row.rateCardId !== existingCard?.id && !placeholderIds.has(row.rateCardId),
  ).length;
  const branchConflicts = allBranches.filter(
    (row) => row.counterRateCardId !== null && row.counterRateCardId !== existingCard?.id && !placeholderIds.has(row.counterRateCardId),
  ).length;

  let existingVersionStatus: "active-matching" | "draft-matching" | "missing-or-mismatched" = "missing-or-mismatched";
  let versionId: string | null = null;
  if (existingCard && !existingCard.placeholder && existingCard.name === NATEX_STANDARD_CARD_NAME) {
    const details = await rateCardService.getRateCard(existingCard.id);
    const active = details.versions.find((version) => version.status === "active");
    const draft = details.versions.find((version) => version.status === "draft");
    if (active && canonical(await documentForVersion(active.id)) === canonical(expected)) {
      existingVersionStatus = "active-matching";
      versionId = active.id;
    } else if (!active && draft && canonical(await documentForVersion(draft.id)) === canonical(expected)) {
      existingVersionStatus = "draft-matching";
      versionId = draft.id;
    }
  }

  const preflight = {
    target,
    mode: apply ? "apply" : "dry-run",
    databaseFingerprint,
    remoteDatabaseReadPerformed: target !== "local-test",
    cardCode: NATEX_STANDARD_CARD_CODE,
    wouldCreateCard: !existingCard,
    existingCardUsable: existingVersionStatus !== "missing-or-mismatched",
    existingVersionStatus,
    branches: allBranches.length,
    merchants: allMerchants.length,
    branchesToAssign: allBranches.filter((row) => row.counterRateCardId !== existingCard?.id).length,
    merchantsToAssign: allMerchants.filter((row) => row.rateCardId !== existingCard?.id).length,
    conflictingExistingAssignments: merchantConflicts + branchConflicts,
    historicalPlaceholderCardsWillBePreserved: true,
    databaseWrites: apply,
  };

  if (!apply) {
    console.log(JSON.stringify(preflight, null, 2));
    return;
  }
  if (merchantConflicts || branchConflicts) {
    throw new Error(
      `Refusing to replace ${merchantConflicts} merchant and ${branchConflicts} branch assignment(s) to another approved card. Resolve these assignments explicitly first.`,
    );
  }

  let cardId: string;
  if (!existingCard) {
    cardId = prefixedId("rtc");
    versionId = prefixedId("rcv");
    const now = new Date();
    const bandRows = expected.bands.map((entry) => ({ id: prefixedId("rbd"), versionId: versionId!, ...entry }));
    const slabRows = expected.slabs.map((entry) => ({ id: prefixedId("rsl"), versionId: versionId!, ...entry }));
    await db.transaction(async (tx) => {
      await tx.insert(rateCard).values({
        id: cardId,
        code: NATEX_STANDARD_CARD_CODE,
        name: NATEX_STANDARD_CARD_NAME,
        placeholder: false,
      });
      await tx.insert(rateCardVersion).values({
        id: versionId!,
        rateCardId: cardId,
        version: 1,
        status: "active",
        volumetricDivisor: expected.volumetricDivisor,
        roundingGrams: expected.roundingGrams,
        note: expected.note,
        activatedAt: now,
        updatedAt: now,
        updatedByName: RECORDED_BY,
      });
      await tx.insert(rateBand).values(bandRows);
      await tx.insert(rateSlab).values(slabRows);
      await tx.insert(auditLog).values(auditValues({
        entity: "merchants_rate_card",
        entityId: cardId,
        action: "rate_card.standard_tariff_created_and_published",
        before: null,
        after: {
          code: NATEX_STANDARD_CARD_CODE,
          name: NATEX_STANDARD_CARD_NAME,
          placeholder: false,
          version: 1,
          status: "active",
          tariff: expected,
          reason: PUBLISH_REASON,
          recordedBy: RECORDED_BY,
        },
        requestId: REQUEST_ID,
      }));
    });
  } else {
    if (existingCard.placeholder || existingCard.name !== NATEX_STANDARD_CARD_NAME) {
      throw new Error(`Rate-card code ${NATEX_STANDARD_CARD_CODE} already exists with a different identity or placeholder flag.`);
    }
    cardId = existingCard.id;
    if (existingVersionStatus === "active-matching") {
      // Existing published tariff exactly matches; only missing assignments may be added.
    } else if (existingVersionStatus === "draft-matching" && versionId) {
      const now = new Date();
      await db.transaction(async (tx) => {
        const [published] = await tx.update(rateCardVersion)
          .set({ status: "active", activatedAt: now, updatedAt: now, updatedByName: RECORDED_BY })
          .where(and(eq(rateCardVersion.id, versionId!), eq(rateCardVersion.status, "draft")))
          .returning({ id: rateCardVersion.id });
        if (!published) throw new Error("The matching draft changed during setup; no publish audit was written.");
        await tx.insert(auditLog).values(auditValues({
          entity: "merchants_rate_card_version",
          entityId: versionId!,
          action: "rate_card.published",
          before: { status: "draft" },
          after: { status: "active", reason: PUBLISH_REASON, recordedBy: RECORDED_BY, recoveredMatchingDraft: true },
          requestId: REQUEST_ID,
        }));
      });
    } else {
      throw new Error(`Existing ${NATEX_STANDARD_CARD_CODE} does not contain the exact approved tariff; refusing to overwrite it.`);
    }
  }

  if (!versionId) {
    const active = await rateCardService.activeVersionOf(cardId);
    if (!active) throw new Error("The standard card has no active version after publish.");
    versionId = active.id;
  }
  await rateCardService.assertCounterRateCard(cardId);

  let merchantsAssigned = 0;
  for (const row of allMerchants) {
    if (row.rateCardId === cardId) continue;
    await db.transaction(async (tx) => {
      const oldAssignment = row.rateCardId === null
        ? isNull(merchant.rateCardId)
        : eq(merchant.rateCardId, row.rateCardId);
      const [updated] = await tx.update(merchant)
        .set({ rateCardId: cardId })
        .where(and(eq(merchant.id, row.id), oldAssignment))
        .returning({ id: merchant.id });
      if (!updated) throw new Error(`Merchant ${row.id} changed rate-card assignment after preflight; review and rerun.`);
      await tx.insert(auditLog).values(auditValues({
        entity: "merchants_merchant",
        entityId: row.id,
        action: "merchant.rate_card_assigned",
        before: { rateCardId: row.rateCardId },
        after: { rateCardId: cardId, cardCode: NATEX_STANDARD_CARD_CODE, recordedBy: RECORDED_BY },
        requestId: REQUEST_ID,
      }));
    });
    merchantsAssigned += 1;
  }

  let branchesAssigned = 0;
  for (const row of allBranches) {
    if (row.counterRateCardId === cardId) continue;
    await db.transaction(async (tx) => {
      const oldAssignment = row.counterRateCardId === null
        ? isNull(branch.counterRateCardId)
        : eq(branch.counterRateCardId, row.counterRateCardId);
      const [updated] = await tx.update(branch)
        .set({ counterRateCardId: cardId })
        .where(and(eq(branch.id, row.id), oldAssignment))
        .returning({ id: branch.id });
      if (!updated) throw new Error(`Branch ${row.id} changed rate-card assignment after preflight; review and rerun.`);
      await tx.insert(auditLog).values(auditValues({
        entity: "identity_branch",
        entityId: row.id,
        action: "branch.counter_rate_card_assigned",
        before: { counterRateCardId: row.counterRateCardId },
        after: { counterRateCardId: cardId, cardCode: NATEX_STANDARD_CARD_CODE, recordedBy: RECORDED_BY },
        requestId: REQUEST_ID,
      }));
    });
    branchesAssigned += 1;
  }

  const merchantAssignments = await db.select({ rateCardId: merchant.rateCardId }).from(merchant);
  const branchAssignments = await identityService.listBranches();
  const unassignedMerchants = merchantAssignments.filter((row) => row.rateCardId !== cardId).length;
  const unassignedBranches = branchAssignments.filter((row) => row.counterRateCardId !== cardId).length;
  if (unassignedMerchants || unassignedBranches) {
    throw new Error(`Post-apply verification failed: ${unassignedMerchants} merchant and ${unassignedBranches} branch assignment(s) remain.`);
  }

  console.log(JSON.stringify({
    target,
    status: "configured-and-verified",
    databaseFingerprint,
    cardCode: NATEX_STANDARD_CARD_CODE,
    cardId,
    activeVersionId: versionId,
    merchantsTotal: merchantAssignments.length,
    merchantsAssigned,
    branchesTotal: branchAssignments.length,
    branchesAssigned,
    unassignedMerchants,
    unassignedBranches,
    placeholderAndHistoricalCardsPreserved: true,
    auditRequestId: REQUEST_ID,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
