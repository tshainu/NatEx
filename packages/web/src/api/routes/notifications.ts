import { z } from "zod";
import { adminProc, deskProc, mutate, readProc } from "../middleware/pipeline";
import * as notifyService from "../modules/notifications/service";
import { errors } from "../shared/errors";

/**
 * notifications routes — Milestone 3 (PROJECT.md §9 messaging, §10 M3
 * "consignee notifications"). Read-only for staff plus an admin-only template
 * editor; nothing here *sends* on request. Sends are enqueued by the module
 * that caused them and drained by jobs/worker.ts, so a doorstep scan never
 * waits on a messaging gateway.
 *
 * KNOWN DEVIATION (README): with no WhatsApp or push credentials configured,
 * both senders fail closed and every message falls through to SMS. The log
 * below shows that plainly — each attempt's channel and state is a row.
 */

export const templates = deskProc
  .input(z.object({}))
  .handler(() => notifyService.listTemplates());

export const template = deskProc
  .input(z.object({ key: z.string().min(3).max(60) }))
  .handler(({ input }) => notifyService.getTemplate(input.key));

/**
 * Editing message copy is an admin act and versioned: every save bumps
 * `version` and stamps who made it, because a consignee complaint about what a
 * message said has to be answerable months later.
 */
export const templateUpdate = adminProc
  .input(
    z.object({
      key: z.string().min(3).max(60),
      bodyWhatsapp: z.string().max(1600).optional(),
      bodySms: z.string().max(480).optional(),
      bodyPush: z.string().max(240).optional(),
      pushTitle: z.string().max(120).optional(),
      /** Ladder order, e.g. "whatsapp,sms" — tried left to right (§9). */
      channelOrder: z.string().max(60).optional(),
      active: z.boolean().optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "notifications.templateUpdate",
        entity: "notify_template",
        entityId: (r) => (r as notifyService.TemplateRow).key,
        action: "notify_template.updated",
      },
      () => {
        const { key, ...patch } = input;
        return notifyService.updateTemplate(key, patch, context.principal);
      },
    ),
  );

/**
 * What an edit would look like before it is saved: the placeholders this
 * message may use, the problems the save would be refused for, and each
 * channel rendered with sample values (§10 M5 template editor).
 */
export const templatePreview = deskProc
  .input(
    z.object({
      key: z.string().min(3).max(60),
      bodyWhatsapp: z.string().max(1600).optional(),
      bodySms: z.string().max(480).optional(),
      bodyPush: z.string().max(240).optional(),
      pushTitle: z.string().max(120).optional(),
      channelOrder: z.string().max(60).optional(),
    }),
  )
  .handler(async ({ input }) => {
    const { key, ...draft } = input;
    const current = await notifyService.getTemplate(key);
    if (!current) errors.notFound(`Template ${key}`);
    const merged = { ...current!, ...draft };
    const sms = notifyService.render(merged.bodySms ?? "", notifyService.SAMPLE_VARS).text;
    return {
      allowed: notifyService.allowedPlaceholders(key, current),
      problems: notifyService.templateProblems(key, draft, current),
      rendered: {
        whatsapp: notifyService.render(merged.bodyWhatsapp ?? "", notifyService.SAMPLE_VARS).text,
        sms,
        push: notifyService.render(merged.bodyPush ?? "", notifyService.SAMPLE_VARS).text,
        pushTitle: notifyService.render(merged.pushTitle ?? "", notifyService.SAMPLE_VARS).text,
      },
      /** GSM-7 160 / segment; an over-long SMS is sent as several billed parts. */
      smsSegments: sms.length <= 160 ? 1 : Math.ceil(sms.length / 153),
      smsLength: sms.length,
    };
  });

/** The send log, newest first — what went out, on which channel, and its state. */
export const messages = deskProc
  .input(
    z.object({
      templateKey: z.string().max(60).optional(),
      channel: z.enum(["whatsapp", "sms", "push"]).optional(),
      state: z.string().max(24).optional(),
      search: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(({ input, context }) => notifyService.listMessages(input, context.principal));

/**
 * Everything ever sent about one parcel. `readProc` so the merchant portal can
 * answer "did you actually tell my customer?" for its own parcels.
 */
export const forParcel = readProc
  .input(z.object({ parcelId: z.string().min(1) }))
  .handler(({ input, context }) =>
    notifyService.messagesForParcel(input.parcelId, context.principal),
  );

/** Channel/state rollup for the ops health panel. */
export const summary = deskProc
  .input(z.object({}))
  .handler(() => notifyService.logSummary());

/** Router namespace — composed into the root router in api/index.ts. */
export const notifications = {
  templates,
  template,
  templateUpdate,
  templatePreview,
  messages,
  forParcel,
  summary,
};
