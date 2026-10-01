import { z } from "zod";
import { mutate, opsProc, readProc } from "../middleware/pipeline";
import * as merchantsService from "../modules/merchants/service";

export const list = readProc
  .input(
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      search: z.string().max(60).optional(),
    }),
  )
  .handler(({ input, context }) => merchantsService.listMerchants(input, context.principal));

export const get = readProc
  .input(z.object({ id: z.string().min(1) }))
  .handler(({ input, context }) => merchantsService.getMerchantScoped(input.id, context.principal));

export const options = readProc.handler(({ context }) =>
  merchantsService.merchantOptions(context.principal),
);

export const create = opsProc
  .input(
    z.object({
      name: z.string().min(2).max(160),
      branchId: z.string().min(1),
      vatNo: z.string().max(40).nullish(),
      address: z.string().min(4),
      lat: z.number().int().nullish(),
      lng: z.number().int().nullish(),
      contactName: z.string().min(2).max(120),
      contactPhone: z.string().min(9).max(20),
      codEnabled: z.boolean().default(true),
      podPolicy: z.enum(["signature", "otp", "photo"]).default("signature"),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "merchants.create",
        entity: "merchants_merchant",
        entityId: (r) => (r as merchantsService.MerchantRow).id,
        action: "merchant.created",
      },
      () => merchantsService.createMerchant(input, context.principal),
    ),
  );

export const setStatus = opsProc
  .input(
    z.object({
      id: z.string().min(1),
      status: z.enum(["active", "suspended"]),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "merchants.setStatus",
        entity: "merchants_merchant",
        entityId: () => input.id,
        action: `merchant.${input.status}`,
      },
      () => merchantsService.setMerchantStatus(input.id, input.status, context.principal),
    ),
  );

/** Router namespace — composed into the root router in api/index.ts. */
export const merchants = {
  list,
  get,
  options,
  create,
  setStatus,
};
