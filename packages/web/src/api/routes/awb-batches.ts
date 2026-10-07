import { z } from "zod";
import { adminProc, mutate } from "../middleware/pipeline";
import * as awbBatchService from "../modules/parcels/awb-batches";
import * as merchantsService from "../modules/merchants/service";
import * as identityService from "../modules/identity/service";

export const list = adminProc.handler(async ({ context }) => {
  const [batches, merchants, locations] = await Promise.all([
    awbBatchService.listAwbBatches(),
    merchantsService.merchantOptions(context.principal),
    identityService.listBranches(),
  ]);
  return { batches, merchants, locations };
});

export const generate = adminProc
  .input(z.object({ count: z.number().int().min(1).max(awbBatchService.MAX_BATCHES_PER_GENERATION) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "awbBatches.generate",
        entity: "parcels_awb_batch",
        entityId: (rows) => (rows as awbBatchService.AwbBatchRow[])[0]?.id ?? "none",
        action: "awb.batch.generated",
      },
      () => awbBatchService.createAwbBatches(input.count, context.principal),
    ),
  );

export const assign = adminProc
  .input(z.object({
    batchId: z.string().min(1).max(100),
    assigneeType: z.enum(["merchant", "branch", "hub"]),
    assigneeId: z.string().min(1).max(100),
  }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "awbBatches.assign",
        entity: "parcels_awb_batch",
        entityId: () => input.batchId,
        action: "awb.batch.assigned",
      },
      () => awbBatchService.assignAwbBatch(input.batchId, input.assigneeType, input.assigneeId, context.principal),
    ),
  );

export const labels = adminProc
  .input(z.object({ batchId: z.string().min(1).max(100) }))
  .handler(({ input }) => awbBatchService.labelsForAwbBatch(input.batchId));

export const awbBatches = { list, generate, assign, labels };
