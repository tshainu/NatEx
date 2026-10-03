import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * MODULE: merchants — NatEx's customers.
 * PROJECT.md §4: only modules/merchants/service.ts reads these tables.
 */

export const merchant = sqliteTable(
  "merchants_merchant",
  {
    id: text("id").primaryKey(),
    /** Branch that owns the relationship — row-level scoping (PROJECT.md §5). */
    branchId: text("branch_id").notNull(),
    name: text("name").notNull(),
    /** Sri Lankan VAT registration number. */
    vatNo: text("vat_no"),
    address: text("address").notNull(),
    /** Geocode once, store forever. */
    lat: integer("lat_e6"),
    lng: integer("lng_e6"),
    contactName: text("contact_name").notNull(),
    contactPhone: text("contact_phone").notNull(),
    /**
     * The rate card FAMILY (merchants_rate_card.id) this merchant is billed
     * under. Pricing uses that family's active version, so publishing a new
     * version re-prices every merchant on it without touching this row.
     */
    rateCardId: text("rate_card_id"),
    codEnabled: integer("cod_enabled", { mode: "boolean" }).notNull().default(true),
    /** POD policy per merchant: signature | otp | photo (M3 enforces it; stored from M1). */
    podPolicy: text("pod_policy").notNull().default("signature"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("merchants_merchant_branch_idx").on(t.branchId)],
);

// ─────────────────────────────────────────────────────────────── rate cards
//
// PROJECT.md §3 puts rate cards in the merchants module. §15 q3 ("rate card
// structure — zones, weight slabs, surcharges, COD fee model?") is OPEN except
// for the COD fee (client 2026-09-30: bundled into the delivery rate, held as
// cod_finance_config, not here). So this is a configurable ENGINE — bands,
// weight slabs, per-kg overflow, surcharges, volumetric divisor — and the only
// seeded card is flagged `placeholder` and says so on every screen and quote.

/** A tariff family. Merchants point at this; versions carry the numbers. */
export const rateCard = sqliteTable("merchants_rate_card", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  /** True for tariffs whose numbers are not client-approved (§15 q3). */
  placeholder: integer("placeholder", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * One version of a tariff. draft → active → superseded. Only a draft is
 * editable; an active version is frozen so an issued quote can always be
 * reproduced. Publishing a draft supersedes the family's previous active one.
 */
export const rateCardVersion = sqliteTable(
  "merchants_rate_card_version",
  {
    id: text("id").primaryKey(),
    rateCardId: text("rate_card_id")
      .notNull()
      .references(() => rateCard.id),
    version: integer("version").notNull(),
    /** draft | active | superseded */
    status: text("status").notNull().default("draft"),
    /** cm³ per kg — chargeable weight is max(actual, L×W×H ÷ divisor). */
    volumetricDivisor: integer("volumetric_divisor").notNull().default(5000),
    /** Weight is rounded UP to this many grams before slab lookup. */
    roundingGrams: integer("rounding_grams").notNull().default(500),
    note: text("note"),
    activatedAt: integer("activated_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedByName: text("updated_by_name"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("merchants_rcv_card_idx").on(t.rateCardId)],
);

/**
 * A pricing band — which lane a parcel travels. `local` = destination served
 * by the origin branch, `outstation` = any other branch. The band RULE is a
 * placeholder pending §15 q3 (zones); the band PRICES are data.
 */
export const rateBand = sqliteTable(
  "merchants_rate_band",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => rateCardVersion.id),
    band: text("band").notNull(),
    label: text("label").notNull(),
    /** Charged per started kg above the heaviest slab. Cents. */
    extraPerKgCents: integer("extra_per_kg_cents").notNull(),
  },
  (t) => [index("merchants_rate_band_version_idx").on(t.versionId)],
);

/** Weight slab: parcels up to `maxGrams` in `band` cost `priceCents`. */
export const rateSlab = sqliteTable(
  "merchants_rate_slab",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => rateCardVersion.id),
    band: text("band").notNull(),
    maxGrams: integer("max_grams").notNull(),
    priceCents: integer("price_cents").notNull(),
  },
  (t) => [index("merchants_rate_slab_version_idx").on(t.versionId)],
);

/**
 * Surcharge. `flat` amounts are cents; `percent` amounts are basis points of
 * the freight charge (§9: no float rates). `always` applies to every parcel,
 * `on_request` only when the booking asks for it (fragile, express...).
 */
export const rateSurcharge = sqliteTable(
  "merchants_rate_surcharge",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => rateCardVersion.id),
    code: text("code").notNull(),
    label: text("label").notNull(),
    /** flat | percent */
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    /** always | on_request */
    mode: text("mode").notNull(),
  },
  (t) => [index("merchants_rate_surcharge_version_idx").on(t.versionId)],
);
