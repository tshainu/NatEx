import { z } from "zod";
import { adminProc, mutate, deskProc, authedProc } from "../middleware/pipeline";
import * as settingsService from "../modules/settings/service";
import { errors } from "../shared/errors";

/**
 * settings routes (§10 M5 "SLA & business rule configuration", "session
 * policy"). Staff may read (ops sees the SLA it works to); only admin writes,
 * with a mandatory reason that lands on the row and in the audit log.
 *
 * Money rules are NOT here: they stay in cod.listConfig / cod.setConfig
 * (finance), so a fee has exactly one home.
 */

const key = z.enum(Object.values(settingsService.SETTING_KEYS) as [settingsService.SettingKey, ...settingsService.SettingKey[]]);

export const list = deskProc.handler(() => settingsService.listSettings());

/** Only this non-sensitive cap is exposed to app clients; edits remain Admin-only. */
export const bookingLimits = authedProc.handler(() => settingsService.bookingLimits());

/** Contact metadata is needed by desk-side receipt printing; the phone is blank until configured. */
export const receiptContact = deskProc.handler(() => settingsService.getReceiptContact());

export const set = adminProc
  .input(z.object({ key, value: z.number(), reason: z.string().trim().min(5).max(500) }))
  .handler(({ input, context }) => {
    const why = settingsService.settingProblem(input.key, input.value);
    if (why) errors.badRequest(`${input.key}: ${why}`, { key: input.key, value: input.value });
    return mutate(
      context,
      input,
      { route: "settings.set", entity: "settings_value", entityId: () => input.key, action: "setting.changed" },
      async () => ({
        key: input.key,
        ...(await settingsService.setSetting({
          key: input.key,
          value: input.value,
          note: input.reason,
          actorName: context.principal.name,
        })),
        reason: input.reason,
      }),
    );
  });

export const setReceiptContact = adminProc
  .input(
    z.object({
      website: z.string().trim().max(200).nullish(),
      companyPhone: z.string().trim().max(40).nullish(),
      reason: z.string().trim().min(5).max(500),
    }),
  )
  .handler(({ input, context }) => {
    const website = input.website ?? null;
    const companyPhone = input.companyPhone ?? null;
    const websiteProblem = settingsService.receiptWebsiteProblem(website);
    if (websiteProblem) errors.badRequest(`receipt website: ${websiteProblem}`, { field: "website" });
    const phoneProblem = settingsService.receiptPhoneProblem(companyPhone);
    if (phoneProblem) errors.badRequest(`receipt company telephone: ${phoneProblem}`, { field: "companyPhone" });
    return mutate(
      context,
      input,
      { route: "settings.setReceiptContact", entity: "settings_receipt_contact", entityId: () => "1", action: "receipt_contact.changed" },
      async () => ({
        ...(await settingsService.setReceiptContact({ website, companyPhone, actorName: context.principal.name })),
        reason: input.reason,
      }),
    );
  });

export const settings = { list, set, bookingLimits, receiptContact, setReceiptContact };
