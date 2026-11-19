import { z } from "zod";
import { financeProc, hrProc, mutate, performanceReadProc } from "../middleware/pipeline";
import { generateStarPayouts, listStarPayouts, riderPerformance, updateStarPayoutStatus } from "../modules/delivery/performance";

const colomboDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const riderDailyPerformance = performanceReadProc.input(z.object({
  fromDate: colomboDate,
  toDate: colomboDate,
  branchId: z.string().min(1).optional(),
  riderId: z.string().min(1).optional(),
})).handler(({ input, context }) => riderPerformance(input, context.principal));

export const starPayouts = performanceReadProc.input(z.object({ fromDate: colomboDate, toDate: colomboDate, branchId: z.string().min(1).optional() })).handler(({ input, context }) => listStarPayouts(input, context.principal));
export const generateStarPayout = hrProc.input(z.object({ fromDate: colomboDate, toDate: colomboDate })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.generateStarPayout", entity: "delivery_rider_daily_performance", entityId: () => `${input.fromDate}:${input.toDate}`, action: "hr.star_payout_generated",
}, () => generateStarPayouts(input, context.principal)));
const statusInput = z.object({ ids: z.array(z.string().min(1)).min(1).max(500), status: z.enum(["review", "approved", "rejected", "paid"]) });
export const reviewStarPayouts = financeProc.input(statusInput).handler(({ input, context }) => mutate(context, input, {
  route: "finance.reviewStarPayouts", entity: "delivery_rider_daily_performance", entityId: () => input.ids.join(","), action: `finance.star_payout_${input.status}`,
}, () => updateStarPayoutStatus(input, context.principal)));
export const approveStarPayouts = hrProc.input(statusInput).handler(({ input, context }) => mutate(context, input, {
  route: "hr.approveStarPayouts", entity: "delivery_rider_daily_performance", entityId: () => input.ids.join(","), action: `hr.star_payout_${input.status}`,
}, () => updateStarPayoutStatus(input, context.principal)));

export const deliveryPerformance = { riderDailyPerformance, starPayouts, generateStarPayout, reviewStarPayouts, approveStarPayouts };
