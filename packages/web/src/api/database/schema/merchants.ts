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
    /** Rate cards are configured in M5 — the reference exists now so no migration is needed later. */
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
