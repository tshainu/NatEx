import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * MODULE: notifications — templates, the channel ladder and the delivery log
 * (PROJECT.md §9 "Notifications", §10 M3 "WhatsApp → SMS → Push, all
 * templates, delivery log").
 *
 * §4: only modules/notifications/service.ts reads these tables.
 *
 * §9 hard rules encoded here:
 * - Non-OTP notifications try WhatsApp, then SMS, then Push. In that order.
 * - OTP is SMS-only. An OTP never enters this ladder — it goes straight
 *   through shared/sms.ts. There is deliberately no otp template row.
 * - Every attempt on every channel is logged, including the ones that were
 *   skipped and why. A notification that silently vanished is a support call
 *   nobody can answer.
 */

/**
 * One message the system can send. Editable in the admin portal (§10 M5), so
 * the body lives in a row rather than in a string literal in the sender.
 *
 * Bodies use {{placeholders}} substituted by the service: awb, consigneeName,
 * merchantName, codAmount, attemptNo, reason, trackUrl, riderName, date.
 */
export const notifyTemplate = sqliteTable(
  "notify_template",
  {
    /** Event key, e.g. "parcel.out_for_delivery". Stable — code references it. */
    key: text("key").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /** Comma-separated ladder, e.g. "whatsapp,sms,push" (§9 order). */
    channelOrder: text("channel_order").notNull().default("whatsapp,sms,push"),
    /** Who receives it: consignee | merchant | rider. */
    audience: text("audience").notNull().default("consignee"),
    bodyWhatsapp: text("body_whatsapp"),
    bodySms: text("body_sms"),
    pushTitle: text("push_title"),
    bodyPush: text("body_push"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Bumped on every edit — the log records which version was sent. */
    version: integer("version").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedByName: text("updated_by_name"),
  },
  (t) => [index("notify_template_audience_idx").on(t.audience)],
);

/**
 * The delivery log (§10 M3). One row per channel attempt, not per message: a
 * notification that failed on WhatsApp and landed on SMS produces two rows,
 * and the pair is the audit trail of what the consignee actually received.
 *
 * APPEND-ONLY except for the state column, which the SMS DLR webhook advances
 * from sent to delivered/undelivered (§9).
 */
export const notifyMessage = sqliteTable(
  "notify_message",
  {
    id: text("id").primaryKey(),
    /** Groups the ladder attempts for one logical notification. */
    groupId: text("group_id").notNull(),
    templateKey: text("template_key").notNull(),
    templateVersion: integer("template_version").notNull().default(1),
    /** whatsapp | sms | push */
    channel: text("channel").notNull(),
    /** Position in the ladder: 1 = first choice. */
    ladderStep: integer("ladder_step").notNull().default(1),

    parcelId: text("parcel_id"),
    awb: text("awb"),
    merchantId: text("merchant_id"),
    audience: text("audience").notNull().default("consignee"),
    toPhone: text("to_phone"),
    toUserId: text("to_user_id"),

    /** queued | sent | delivered | failed | skipped */
    state: text("state").notNull().default("queued"),
    /** Why a channel was skipped or failed — verbatim, never summarised away. */
    reason: text("reason"),
    body: text("body").notNull(),
    /** shared_sms_log.id when the channel was sms. */
    smsLogId: text("sms_log_id"),
    providerRef: text("provider_ref"),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("notify_message_group_idx").on(t.groupId),
    index("notify_message_parcel_idx").on(t.parcelId),
    index("notify_message_state_idx").on(t.state),
    index("notify_message_template_idx").on(t.templateKey),
    index("notify_message_created_idx").on(t.createdAt),
  ],
);
