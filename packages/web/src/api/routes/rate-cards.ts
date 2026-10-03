import { z } from "zod";
import { adminProc, mutate, deskProc } from "../middleware/pipeline";
import * as rateCardService from "../modules/merchants/rate-cards";

/**
 * rateCards routes (§10 M5 "rate cards"; §3 merchants module).
 *
 * §15 q3 is OPEN: the engine is real, the numbers are not. Every read carries
 * the card's `placeholder` flag. Admin writes; staff may read and quote.
 */

const band = z.object({
  band: z.string().trim().regex(/^[a-z][a-z0-9_]{1,23}$/, "lower-case letters, digits and _"),
  label: z.string().trim().min(2).max(80),
  extraPerKgCents: z.number().int().min(0).max(100_000_000),
});
const slab = z.object({
  band: z.string().trim().min(2).max(24),
  maxGrams: z.number().int().min(1).max(1_000_000),
  priceCents: z.number().int().min(0).max(100_000_000),
});
const surcharge = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,23}$/, "lower-case letters, digits and _"),
  label: z.string().trim().min(2).max(80),
  kind: z.enum(["flat", "percent"]),
  amount: z.number().int().min(0).max(100_000_000),
  mode: z.enum(["always", "on_request"]),
});
const quoteInput = z.object({
  band: z.string().min(1),
  weightGrams: z.number().int().min(1).max(1_000_000),
  lengthCm: z.number().int().min(1).max(1000).nullish(),
  widthCm: z.number().int().min(1).max(1000).nullish(),
  heightCm: z.number().int().min(1).max(1000).nullish(),
  requested: z.array(z.string()).max(10).default([]),
});

export const list = deskProc.handler(() => rateCardService.listRateCards());

export const get = deskProc.input(z.object({ id: z.string().min(1) })).handler(({ input }) => rateCardService.getRateCard(input.id));

export const version = deskProc
  .input(z.object({ versionId: z.string().min(1) }))
  .handler(({ input }) => rateCardService.getVersion(input.versionId));

export const create = adminProc
  .input(
    z.object({
      code: z.string().trim().regex(/^[A-Za-z0-9-]{3,24}$/, "3–24 letters, digits or -"),
      name: z.string().trim().min(3).max(120),
      placeholder: z.boolean().default(true),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "rateCards.create",
        entity: "merchants_rate_card",
        entityId: (r) => (r as { card: { id: string } }).card.id,
        action: "rate_card.created",
      },
      () => rateCardService.createRateCard({ ...input, actorName: context.principal.name }),
    ),
  );

export const update = adminProc
  .input(z.object({ id: z.string().min(1), name: z.string().trim().min(3).max(120).optional(), placeholder: z.boolean().optional() }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      { route: "rateCards.update", entity: "merchants_rate_card", entityId: () => input.id, action: "rate_card.updated" },
      () => rateCardService.renameRateCard(input.id, input),
    ),
  );

export const newDraft = adminProc.input(z.object({ rateCardId: z.string().min(1) })).handler(({ input, context }) =>
  mutate(
    context,
    input,
    {
      route: "rateCards.newDraft",
      entity: "merchants_rate_card",
      entityId: () => input.rateCardId,
      action: "rate_card.draft_opened",
    },
    () => rateCardService.newDraft(input.rateCardId, context.principal.name),
  ),
);

export const saveDraft = adminProc
  .input(
    z.object({
      versionId: z.string().min(1),
      volumetricDivisor: z.number().int().min(1).max(100_000),
      roundingGrams: z.number().int().min(1).max(100_000),
      note: z.string().trim().max(1000).nullish(),
      bands: z.array(band).min(1).max(20),
      slabs: z.array(slab).max(200),
      surcharges: z.array(surcharge).max(30),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "rateCards.saveDraft",
        entity: "merchants_rate_card_version",
        entityId: () => input.versionId,
        action: "rate_card.draft_saved",
      },
      () =>
        rateCardService.saveDraft(
          input.versionId,
          {
            volumetricDivisor: input.volumetricDivisor,
            roundingGrams: input.roundingGrams,
            note: input.note ?? null,
            bands: input.bands,
            slabs: input.slabs,
            surcharges: input.surcharges,
          },
          context.principal.name,
        ),
    ),
  );

export const publish = adminProc
  .input(z.object({ versionId: z.string().min(1), reason: z.string().trim().min(5).max(500) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "rateCards.publish",
        entity: "merchants_rate_card_version",
        entityId: () => input.versionId,
        action: "rate_card.published",
      },
      async () => ({ ...(await rateCardService.publishDraft(input.versionId, context.principal.name)), reason: input.reason }),
    ),
  );

export const discard = adminProc.input(z.object({ versionId: z.string().min(1) })).handler(({ input, context }) =>
  mutate(
    context,
    input,
    {
      route: "rateCards.discard",
      entity: "merchants_rate_card_version",
      entityId: () => input.versionId,
      action: "rate_card.draft_discarded",
    },
    () => rateCardService.discardDraft(input.versionId),
  ),
);

/** Preview a price against any version, drafts included. Read-only. */
export const quote = deskProc
  .input(quoteInput.extend({ versionId: z.string().min(1) }))
  .handler(({ input }) => {
    const { versionId, ...q } = input;
    return rateCardService.quoteVersion(versionId, q);
  });

/** Price for a merchant on its assigned card's active version. */
export const quoteForMerchant = deskProc
  .input(quoteInput.extend({ merchantId: z.string().min(1) }))
  .handler(({ input }) => {
    const { merchantId, ...q } = input;
    return rateCardService.quoteForMerchant(merchantId, q);
  });

export const assign = adminProc
  .input(z.object({ merchantId: z.string().min(1), rateCardId: z.string().min(1).nullable() }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "rateCards.assign",
        entity: "merchants_merchant",
        entityId: () => input.merchantId,
        action: "merchant.rate_card_assigned",
      },
      () => rateCardService.assignRateCard(input.merchantId, input.rateCardId),
    ),
  );

export const rateCards = {
  list,
  get,
  version,
  create,
  update,
  newDraft,
  saveDraft,
  publish,
  discard,
  quote,
  quoteForMerchant,
  assign,
};
