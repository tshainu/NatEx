import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../../database";
import { notifyMessage, notifyTemplate } from "../../database/schema/notifications";
import { isGlobalScope, type Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { formatLkr } from "../../shared/money";
import { normaliseLkPhone, sendSms } from "../../shared/sms";
import { prefixedId } from "../../shared/ulid";

/**
 * MODULE: notifications — the ONLY file that reads notify_* tables (§4).
 *
 * PROJECT.md §9, "Notifications":
 *   "Channel order for non-OTP notifications: WhatsApp → SMS → Push."
 *   "OTP is SMS-only. No WhatsApp OTP, no voice fallback."
 *
 * The ladder walks the template's channels in order and stops at the first one
 * that reports a send. Every step it passes over is logged with the reason it
 * was skipped, because "the customer never got the message" has to be
 * answerable from the database alone.
 *
 * KNOWN DEVIATION: no WhatsApp Business account and no FCM/APNs project exist
 * in this environment. The WhatsApp and Push senders are therefore real
 * functions guarded by real configuration checks that currently fail closed:
 * each logs a `skipped` row naming the missing environment variable and the
 * ladder falls through to SMS. Nothing is faked as sent. Configure
 * WHATSAPP_API_URL + WHATSAPP_TOKEN or EXPO_PUSH_URL and the same code path
 * starts delivering without an edit.
 */

export type TemplateRow = typeof notifyTemplate.$inferSelect;
export type MessageRow = typeof notifyMessage.$inferSelect;

export type Channel = "whatsapp" | "sms" | "push";

const CHANNELS: readonly Channel[] = ["whatsapp", "sms", "push"] as const;

// ------------------------------------------------------------------ templates

/**
 * The templates the system ships with. §10 M3 requires "all templates"; §10 M5
 * hands their editing to the admin portal, which is why they are rows and not
 * constants. Seeding is idempotent — an edited row is never overwritten.
 */
export const DEFAULT_TEMPLATES: {
  key: string;
  name: string;
  description: string;
  audience: "consignee" | "merchant" | "rider";
  channelOrder: string;
  bodyWhatsapp: string;
  bodySms: string;
  pushTitle: string;
  bodyPush: string;
}[] = [
  {
    key: "parcel.booked",
    name: "Parcel booked",
    description: "Sent to the consignee when a merchant books a parcel to them.",
    audience: "consignee",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "Hello {{consigneeName}}, {{merchantName}} has booked a NatEx delivery to you. Your tracking number is {{awb}}. Track it at {{trackUrl}}",
    bodySms: "NatEx: {{merchantName}} booked a delivery to you. AWB {{awb}}. {{trackUrl}}",
    pushTitle: "Parcel booked",
    bodyPush: "{{merchantName}} booked a delivery to you — AWB {{awb}}.",
  },
  {
    key: "parcel.out_for_delivery",
    name: "Out for delivery",
    description: "Sent when a runsheet is dispatched and the parcel is on a rider.",
    audience: "consignee",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "Hello {{consigneeName}}, your NatEx parcel {{awb}} is out for delivery today. {{codLine}}Our rider {{riderName}} will call you. Track: {{trackUrl}}",
    bodySms:
      "NatEx {{awb}} is out for delivery today. {{codLine}}Rider: {{riderName}}. {{trackUrl}}",
    pushTitle: "Out for delivery",
    bodyPush: "Parcel {{awb}} is out for delivery today.",
  },
  {
    key: "parcel.delivered",
    name: "Delivered",
    description: "Sent to the consignee on a successful delivery with POD.",
    audience: "consignee",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "Your NatEx parcel {{awb}} was delivered on {{date}} and received by {{receivedBy}}. Thank you.",
    bodySms: "NatEx {{awb}} delivered on {{date}}, received by {{receivedBy}}. Thank you.",
    pushTitle: "Delivered",
    bodyPush: "Parcel {{awb}} was delivered.",
  },
  {
    key: "parcel.delivery_failed",
    name: "Delivery attempt failed",
    description: "Sent to the consignee after a failed doorstep attempt.",
    audience: "consignee",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "We could not deliver your NatEx parcel {{awb}} today ({{reason}}). This was attempt {{attemptNo}} of 3. Reply to this message or call us to arrange redelivery. {{trackUrl}}",
    bodySms:
      "NatEx {{awb}}: delivery attempt {{attemptNo}} of 3 failed ({{reason}}). Call 0112 000 000 to rearrange. {{trackUrl}}",
    pushTitle: "Delivery attempt failed",
    bodyPush: "Attempt {{attemptNo}} of 3 on {{awb}} failed: {{reason}}.",
  },
  {
    key: "parcel.rto_initiated",
    name: "Return to sender started",
    description: "Sent to the merchant when a parcel is turned back.",
    audience: "merchant",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "NatEx: parcel {{awb}} to {{consigneeName}} is being returned to you. Reason: {{reason}}.",
    bodySms: "NatEx: {{awb}} is being returned to you. Reason: {{reason}}.",
    pushTitle: "Return to sender",
    bodyPush: "{{awb}} is being returned. {{reason}}",
  },
  {
    key: "parcel.rto_delivered",
    name: "Return completed",
    description: "Sent to the merchant when a returned parcel is handed back.",
    audience: "merchant",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "NatEx: returned parcel {{awb}} was handed back to {{receivedBy}} on {{date}}.",
    bodySms: "NatEx: returned parcel {{awb}} handed back to {{receivedBy}} on {{date}}.",
    pushTitle: "Return completed",
    bodyPush: "Returned parcel {{awb}} handed back.",
  },
  {
    key: "ndr.raised",
    name: "NDR raised",
    description: "Sent to the merchant when a parcel enters the NDR queue.",
    audience: "merchant",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "NatEx needs your instruction on {{awb}} ({{consigneeName}}): {{reason}}. Attempt {{attemptNo}} of 3. Tell us to reattempt or return, in the merchant portal, before {{slaDue}}.",
    bodySms:
      "NatEx {{awb}}: delivery failed ({{reason}}). Instruct reattempt or return before {{slaDue}}.",
    pushTitle: "Instruction needed",
    bodyPush: "{{awb}} failed delivery — instruction needed by {{slaDue}}.",
  },
  {
    key: "pickup.collected",
    name: "Pickup collected",
    description: "Sent to the merchant when a rider takes custody of a manifest.",
    audience: "merchant",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "NatEx collected {{itemCount}} parcel(s) from you on manifest {{manifestCode}}. Rider: {{riderName}}.",
    bodySms: "NatEx collected {{itemCount}} parcel(s) on manifest {{manifestCode}}.",
    pushTitle: "Pickup collected",
    bodyPush: "{{itemCount}} parcel(s) collected on {{manifestCode}}.",
  },
  {
    key: "pickup.rider_parcel_assigned",
    name: "Merchant parcel ready for pickup",
    description: "Sent to the preferred branch/hub Rider when a merchant books a new parcel for collection.",
    audience: "rider",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "New pickup for {{merchantName}}. AWB {{awb}} is on manifest {{manifestCode}} for {{pickupDate}}. Open the Rider app for the pickup address, scan the parcel, and confirm handover.",
    bodySms:
      "NatEx pickup: {{merchantName}} booked {{awb}}. Manifest {{manifestCode}} for {{pickupDate}}. Open Rider app for the address.",
    pushTitle: "New merchant pickup",
    bodyPush: "Collect {{awb}} from {{merchantName}}. Manifest {{manifestCode}}.",
  },
  /**
   * M4 (§8): the merchant's COD payout left the bank. Client-confirmed as
   * wanted, on `paid` — not on `approved`, because an approved run has no UTR
   * yet and a merchant told "released" before the money moves will ring the
   * desk the same afternoon. `settlement.approved` stays an internal
   * finance-desk record in `cod_ops_alert`.
   *
   * `{{netAmount}}` is pre-formatted by the caller (`formatLkr`) rather than
   * passed as cents — a merchant reads "Rs. 12,450.00", and no template should
   * be doing money arithmetic.
   */
  {
    key: "settlement.paid",
    name: "COD payout released",
    description: "Sent to the merchant when a settlement run is paid and the UTR is recorded.",
    audience: "merchant",
    channelOrder: "whatsapp,sms,push",
    bodyWhatsapp:
      "NatEx has released your COD payout for {{periodStart}}–{{periodEnd}}: {{netAmount}} (settlement {{code}}, {{lineCount}} parcel(s), {{deductions}} deducted). Bank reference {{utr}}. The full statement is in your merchant portal.",
    bodySms: "NatEx paid your COD settlement {{code}}: {{netAmount}}. Ref {{utr}}.",
    pushTitle: "COD payout released",
    bodyPush: "{{netAmount}} paid for {{periodStart}}–{{periodEnd}}. Ref {{utr}}.",
  },
];

export async function seedTemplates(): Promise<number> {
  let inserted = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const [existing] = await db
      .select({ key: notifyTemplate.key })
      .from(notifyTemplate)
      .where(eq(notifyTemplate.key, t.key));
    if (existing) continue;
    await db.insert(notifyTemplate).values({ ...t, active: true, version: 1 });
    inserted += 1;
  }
  return inserted;
}

export async function listTemplates(): Promise<TemplateRow[]> {
  return db.select().from(notifyTemplate).orderBy(notifyTemplate.audience, notifyTemplate.key);
}

export async function getTemplate(key: string): Promise<TemplateRow | null> {
  const [row] = await db.select().from(notifyTemplate).where(eq(notifyTemplate.key, key));
  if (row) return row;

  // Existing production databases may not have run the destructive seed. Add
  // a missing shipped template on first use, but never overwrite admin edits.
  const shipped = DEFAULT_TEMPLATES.find((template) => template.key === key);
  if (!shipped) return null;
  await db
    .insert(notifyTemplate)
    .values({ ...shipped, active: true, version: 1 })
    .onConflictDoNothing();
  const [provisioned] = await db.select().from(notifyTemplate).where(eq(notifyTemplate.key, key));
  return provisioned ?? null;
}

/** Template editing — exposed to admin in M5, used by tests and seeds now. */
export async function updateTemplate(
  key: string,
  patch: Partial<Pick<TemplateRow, "bodyWhatsapp" | "bodySms" | "bodyPush" | "pushTitle" | "channelOrder" | "active">>,
  actor: Principal,
): Promise<TemplateRow> {
  const current = await getTemplate(key);
  if (!current) errors.notFound(`Template ${key}`);
  const problems = templateProblems(key, patch, current!);
  if (problems.length) errors.badRequest(problems[0]!, { problems });
  const [row] = await db
    .update(notifyTemplate)
    .set({
      ...patch,
      version: current!.version + 1,
      updatedAt: new Date(),
      updatedByName: actor.name,
    })
    .where(eq(notifyTemplate.key, key))
    .returning();
  return row!;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function placeholdersIn(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/**
 * The placeholders the sending code actually supplies for a template: exactly
 * the ones its shipped default uses (§10 M5 template editor). An edit that
 * introduces any other name would render as a blank to a customer, so it is
 * refused instead.
 */
export function allowedPlaceholders(key: string, current?: TemplateRow | null): string[] {
  const def = DEFAULT_TEMPLATES.find((t) => t.key === key);
  const source = def ?? current;
  if (!source) return [];
  return [
    ...new Set([
      ...placeholdersIn(source.bodyWhatsapp),
      ...placeholdersIn(source.bodySms),
      ...placeholdersIn(source.bodyPush),
      ...placeholdersIn(source.pushTitle),
    ]),
  ].sort();
}

/** Why a template edit is refused; [] when it is fine. */
export function templateProblems(
  key: string,
  patch: Partial<Pick<TemplateRow, "bodyWhatsapp" | "bodySms" | "bodyPush" | "pushTitle" | "channelOrder" | "active">>,
  current: TemplateRow | null,
): string[] {
  const out: string[] = [];
  const allowed = new Set(allowedPlaceholders(key, current));
  const fields = [
    ["WhatsApp body", patch.bodyWhatsapp],
    ["SMS body", patch.bodySms],
    ["Push body", patch.bodyPush],
    ["Push title", patch.pushTitle],
  ] as const;
  for (const [label, text] of fields) {
    if (text === undefined || text === null) continue;
    if (label !== "Push title" && !text.trim()) out.push(`${label} cannot be empty.`);
    for (const name of placeholdersIn(text)) {
      if (!allowed.has(name)) {
        out.push(`${label}: {{${name}}} is not supplied for this message. Use one of: ${[...allowed].map((a) => `{{${a}}}`).join(", ")}.`);
      }
    }
    // A brace the renderer will not substitute: "{{ awb }}", "{awb}", "{{awb}".
    const stripped = text.replace(PLACEHOLDER, "");
    if (/[{}]/.test(stripped)) out.push(`${label}: a placeholder is malformed — write it as {{name}}, no spaces.`);
  }
  if (patch.channelOrder !== undefined) {
    const parts = patch.channelOrder.split(",").map((c) => c.trim()).filter(Boolean);
    if (parts.length === 0) out.push("At least one channel is required.");
    for (const c of parts) if (!(CHANNELS as readonly string[]).includes(c)) out.push(`Unknown channel "${c}". Use whatsapp, sms, push.`);
    if (new Set(parts).size !== parts.length) out.push("A channel appears twice in the ladder.");
  }
  return out;
}

/** Sample values, so the editor can show what a customer would read. */
export const SAMPLE_VARS: Vars = {
  consigneeName: "Meena Ganesan",
  merchantName: "Ceylon Threads",
  awb: "NX2610020001",
  trackUrl: "natex.lk/track/NX2610020001",
  codLine: "Please have Rs. 2,450.00 ready. ",
  riderName: "Karthik",
  manifestCode: "MF261010-001",
  pickupDate: "10 Oct 2026",
  date: "2 Oct 2026",
  receivedBy: "Meena Ganesan",
  reason: "Consignee not available",
  attemptNo: 1,
};

// -------------------------------------------------------------- substitution

export type Vars = Record<string, string | number | null | undefined>;

/**
 * {{placeholder}} substitution. A placeholder with no value becomes an empty
 * string rather than leaking "{{codLine}}" to a customer — and the unresolved
 * key is recorded on the log row so a broken template is visible in the log
 * instead of only in complaints.
 */
export function render(body: string, vars: Vars): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const value = vars[key];
    // undefined/null means the caller forgot the variable — worth reporting.
    // An empty string is a deliberate blank: `codLine()` returns "" for a
    // non-COD parcel, and that is the template rendering correctly, not a gap.
    if (value === undefined || value === null) {
      missing.push(key);
      return "";
    }
    return String(value);
  });
  return { text: text.replace(/\s{2,}/g, " ").trim(), missing };
}

/** "Please have Rs. 1,250.00 ready. " or "" — used by the OFD templates. */
export function codLine(codAmountCents: number): string {
  if (codAmountCents <= 0) return "";
  return `Please have ${formatLkr(codAmountCents)} ready. `;
}

// ------------------------------------------------------------------ channels

interface ChannelResult {
  state: "sent" | "failed" | "skipped";
  reason?: string;
  providerRef?: string | null;
  smsLogId?: string | null;
}

/**
 * WhatsApp Business Cloud API. Fails closed when unconfigured: §9 puts
 * WhatsApp first in the ladder, so an unconfigured WhatsApp must skip cleanly
 * and let SMS carry the message — never swallow it.
 */
async function sendWhatsapp(to: string, body: string): Promise<ChannelResult> {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_TOKEN;
  if (!url || !token) {
    return {
      state: "skipped",
      reason: "WhatsApp not configured (WHATSAPP_API_URL / WHATSAPP_TOKEN unset).",
    };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normaliseLkPhone(to),
        type: "text",
        text: { body },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text();
    if (!res.ok) return { state: "failed", reason: `WhatsApp ${res.status}: ${raw.slice(0, 200)}` };
    let ref: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { messages?: { id?: string }[] };
      ref = parsed.messages?.[0]?.id ?? null;
    } catch {
      ref = null;
    }
    return { state: "sent", providerRef: ref };
  } catch (err) {
    return {
      state: "failed",
      reason: `WhatsApp transport: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Expo push. Skips when the recipient has no push token — a consignee never
 * has one (they do not install a courier app), which is precisely why §9 puts
 * push last rather than first.
 */
async function sendPush(
  pushToken: string | null,
  title: string,
  body: string,
): Promise<ChannelResult> {
  const url = process.env.EXPO_PUSH_URL;
  if (!pushToken) {
    return { state: "skipped", reason: "No push token registered for this recipient." };
  }
  if (!url) return { state: "skipped", reason: "Push not configured (EXPO_PUSH_URL unset)." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: pushToken, title, body }),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text();
    if (!res.ok) return { state: "failed", reason: `Push ${res.status}: ${raw.slice(0, 200)}` };
    return { state: "sent", providerRef: null };
  } catch (err) {
    return {
      state: "failed",
      reason: `Push transport: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// -------------------------------------------------------------------- sending

export interface NotifyInput {
  templateKey: string;
  vars: Vars;
  toPhone?: string | null;
  toUserId?: string | null;
  pushToken?: string | null;
  parcelId?: string | null;
  awb?: string | null;
  merchantId?: string | null;
}

export interface NotifyResult {
  groupId: string;
  delivered: boolean;
  channel: Channel | null;
  attempts: { channel: Channel; state: string; reason?: string }[];
}

/**
 * Walk the ladder. Called from the outbox worker, never inline in a request
 * handler (§4: "every background job runs off the outbox table").
 */
export async function dispatch(input: NotifyInput): Promise<NotifyResult> {
  const template = await getTemplate(input.templateKey);
  if (!template) errors.notFound(`Template ${input.templateKey}`);
  const groupId = prefixedId("ntg");
  const attempts: NotifyResult["attempts"] = [];

  if (!template!.active) {
    await logStep({
      groupId,
      template: template!,
      channel: "sms",
      step: 1,
      input,
      body: "",
      result: { state: "skipped", reason: "Template is inactive." },
    });
    return { groupId, delivered: false, channel: null, attempts: [] };
  }

  const ladder = template!.channelOrder
    .split(",")
    .map((c) => c.trim() as Channel)
    .filter((c) => CHANNELS.includes(c));

  let step = 0;
  for (const channel of ladder) {
    step += 1;
    const source =
      channel === "whatsapp"
        ? template!.bodyWhatsapp
        : channel === "sms"
          ? template!.bodySms
          : template!.bodyPush;

    if (!source) {
      const result: ChannelResult = {
        state: "skipped",
        reason: `Template ${template!.key} has no ${channel} body.`,
      };
      attempts.push({ channel, state: result.state, reason: result.reason });
      await logStep({ groupId, template: template!, channel, step, input, body: "", result });
      continue;
    }

    const { text, missing } = render(source, input.vars);
    let result: ChannelResult;

    if (channel === "push") {
      const title = render(template!.pushTitle ?? template!.name, input.vars).text;
      result = await sendPush(input.pushToken ?? null, title, text);
    } else if (!input.toPhone) {
      result = { state: "skipped", reason: "No phone number for this recipient." };
    } else if (channel === "whatsapp") {
      result = await sendWhatsapp(input.toPhone, text);
    } else {
      const sms = await sendSms({ to: input.toPhone, body: text, purpose: "notification" });
      result =
        sms.state === "failed"
          ? { state: "failed", reason: sms.raw.slice(0, 300), smsLogId: sms.logId }
          : { state: "sent", providerRef: sms.gatewayRef, smsLogId: sms.logId };
    }

    if (missing.length > 0) {
      result.reason = `${result.reason ?? ""} Unresolved placeholders: ${missing.join(", ")}.`.trim();
    }

    attempts.push({ channel, state: result.state, reason: result.reason });
    await logStep({ groupId, template: template!, channel, step, input, body: text, result });

    // First channel that reports a send wins; the rest of the ladder is not tried.
    if (result.state === "sent") {
      return { groupId, delivered: true, channel, attempts };
    }
  }

  return { groupId, delivered: false, channel: null, attempts };
}

async function logStep(params: {
  groupId: string;
  template: TemplateRow;
  channel: Channel;
  step: number;
  input: NotifyInput;
  body: string;
  result: ChannelResult;
}): Promise<void> {
  await db.insert(notifyMessage).values({
    id: prefixedId("ntm"),
    groupId: params.groupId,
    templateKey: params.template.key,
    templateVersion: params.template.version,
    channel: params.channel,
    ladderStep: params.step,
    parcelId: params.input.parcelId ?? null,
    awb: params.input.awb ?? null,
    merchantId: params.input.merchantId ?? null,
    audience: params.template.audience,
    toPhone: params.input.toPhone ? normaliseLkPhone(params.input.toPhone) : null,
    toUserId: params.input.toUserId ?? null,
    state: params.result.state,
    reason: params.result.reason ?? null,
    body: params.body,
    smsLogId: params.result.smsLogId ?? null,
    providerRef: params.result.providerRef ?? null,
  });
}

// ------------------------------------------------------------------ read paths

export interface ListMessagesInput {
  templateKey?: string;
  channel?: Channel;
  state?: string;
  search?: string;
  limit?: number;
}

/** The delivery log (§10 M3). Newest first — support reads it top-down. */
export async function listMessages(
  input: ListMessagesInput,
  scope: Principal,
): Promise<MessageRow[]> {
  const filters = [];
  if (input.templateKey) filters.push(eq(notifyMessage.templateKey, input.templateKey));
  if (input.channel) filters.push(eq(notifyMessage.channel, input.channel));
  if (input.state) filters.push(eq(notifyMessage.state, input.state));
  if (input.search) {
    const q = `%${input.search.trim().toUpperCase()}%`;
    filters.push(or(like(notifyMessage.awb, q), like(notifyMessage.toPhone, `%${input.search.trim()}%`)));
  }
  // §5 row-level scoping: a merchant sees only notifications about its parcels.
  if (!isGlobalScope(scope.role) && scope.role === "merchant") {
    filters.push(eq(notifyMessage.merchantId, scope.merchantId ?? "__none__"));
  }

  return db
    .select()
    .from(notifyMessage)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(notifyMessage.createdAt))
    .limit(Math.min(input.limit ?? 100, 300));
}

/**
 * Everything sent about one parcel, oldest first — the notification timeline.
 *
 * Takes the principal because the route is merchant-reachable and an AWB /
 * parcel id is guessable: without the §5 row filter a merchant could read the
 * consignee phone numbers and message bodies of a competitor's parcels by
 * iterating ids. A merchant asking about a parcel that is not theirs gets an
 * empty timeline, the same answer as a parcel with no messages — no existence
 * oracle either.
 */
export async function messagesForParcel(
  parcelId: string,
  scope: Principal,
): Promise<MessageRow[]> {
  const filters = [eq(notifyMessage.parcelId, parcelId)];
  if (!isGlobalScope(scope.role) && scope.role === "merchant") {
    filters.push(eq(notifyMessage.merchantId, scope.merchantId ?? "__none__"));
  }
  return db
    .select()
    .from(notifyMessage)
    .where(and(...filters))
    .orderBy(notifyMessage.createdAt);
}

export async function logSummary(): Promise<{
  channel: string;
  state: string;
  count: number;
}[]> {
  const rows = await db
    .select({
      channel: notifyMessage.channel,
      state: notifyMessage.state,
      count: sql<number>`count(*)`,
    })
    .from(notifyMessage)
    .groupBy(notifyMessage.channel, notifyMessage.state);
  return rows;
}

/** Advance a message when the SMS DLR webhook resolves its underlying send (§9). */
export async function applyDlr(smsLogId: string, state: "delivered" | "failed" | "sent"): Promise<number> {
  const res = await db
    .update(notifyMessage)
    .set({ state, updatedAt: new Date() })
    .where(and(eq(notifyMessage.smsLogId, smsLogId), inArray(notifyMessage.state, ["queued", "sent"])))
    .returning({ id: notifyMessage.id });
  return res.length;
}

export async function templateCount(): Promise<number> {
  const [row] = await db.select({ value: sql<number>`count(*)` }).from(notifyTemplate);
  return row?.value ?? 0;
}
