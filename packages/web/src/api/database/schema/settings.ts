import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * MODULE: settings — SLA, business-rule and session-policy values that M5's
 * admin portal edits without a deploy (§10 M5 "SLA & business rule
 * configuration", "session policy").
 *
 * Only modules/settings/service.ts reads this table (§4). Money-module values
 * (fees, tax flags, cash ceiling, settlement cycle) are NOT here — they stay in
 * cod_finance_config, owned by the cod module, so each number has exactly one
 * home. Integers only, like every configured value in this codebase.
 */
export const settingValue = sqliteTable("settings_value", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
  note: text("note"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  updatedByName: text("updated_by_name"),
});
