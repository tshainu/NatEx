import { z } from "zod";
import { adminProc, mutate } from "../middleware/pipeline";
import * as awbBatchService from "../modules/parcels/awb-batches";
import * as merchantsService from "../modules/merchants/service";

export const list = adminProc.handler(async ({ context }) => {
  const [batches, merchants] = await Promise.all([
    awbBatchService.listAwbBatches(),
    merchantsService.merchantOptions(context.principal),
  ]);
  return { batches, merchants };
});

export const create = adminProc
  .input(z.object({ merchantId: z.string().min(1).max(100) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "awbBatches.create",
        entity: "parcels_awb_batch",
        entityId: (row) => (row as awbBatchService.AwbBatchRow).id,
        action: "awb.batch.generated",
      },
      () => awbBatchService.createAwbBatch(input.merchantId, context.principal),
    ),
  );

export const labels = adminProc
  .input(z.object({ batchId: z.string().min(1).max(100) }))
  .handler(({ input }) => awbBatchService.labelsForAwbBatch(input.batchId));

export const awbBatches = { list, create, labels };
