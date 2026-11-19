import { asc, eq } from "drizzle-orm";
import { db } from "../../database";
import { hrLeavePayoutLine, hrLeavePayoutRun, hrLeaveType } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { listEmployees, packageForPeriod } from "./service";
import { leaveBalance } from "./leave";
import { colomboToday } from "../../shared/time";

function assertEligibleYear(year: number) {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) errors.badRequest("Leave payout year must be between 2020 and 2100.");
  const cutoff = `${year}-12-27`;
  if (colomboToday() < cutoff) errors.conflict(`The ${year} leave payout can be generated from ${cutoff}.`);
}

export async function listPayoutRuns() {
  return db.select().from(hrLeavePayoutRun).orderBy(asc(hrLeavePayoutRun.year));
}

export async function getPayoutRun(runId: string) {
  const [run] = await db.select().from(hrLeavePayoutRun).where(eq(hrLeavePayoutRun.id, runId));
  if (!run) errors.notFound("Leave payout run");
  const lines = await db.select().from(hrLeavePayoutLine).where(eq(hrLeavePayoutLine.runId, runId)).orderBy(asc(hrLeavePayoutLine.employeeCode));
  return { run: run!, lines };
}

/** Generate a reproducible snapshot. Only paid ANNUAL leave is eligible. */
export async function generatePayout(year: number, actor: Principal) {
  assertEligibleYear(year);
  const [annual] = await db.select().from(hrLeaveType).where(eq(hrLeaveType.code, "ANNUAL"));
  if (!annual) errors.conflict("The ANNUAL leave type has not been configured.");
  const [existing] = await db.select().from(hrLeavePayoutRun).where(eq(hrLeavePayoutRun.year, year));
  if (existing && ["submitted", "approved", "paid"].includes(existing.status)) errors.conflict(`The ${year} payout is already ${existing.status}; it cannot be regenerated.`);
  if (existing) {
    await db.delete(hrLeavePayoutLine).where(eq(hrLeavePayoutLine.runId, existing.id));
    await db.delete(hrLeavePayoutRun).where(eq(hrLeavePayoutRun.id, existing.id));
  }
  const employees = await listEmployees({ status: "active", limit: 5000 });
  const lines: Array<typeof hrLeavePayoutLine.$inferInsert> = [];
  for (const employee of employees) {
    const balance = await leaveBalance(employee.id, annual!.id, year);
    const availableHalfDays = Math.max(0, balance.availableHalfDays);
    if (availableHalfDays === 0) continue;
    const assignment = await packageForPeriod(employee.id, `${year}-12-01`, `${year}-12-31`);
    if (!assignment) continue;
    const basicSalaryCents = assignment.package.basePayCents;
    const payoutCents = Math.floor((availableHalfDays * basicSalaryCents) / 50);
    if (payoutCents <= 0) continue;
    lines.push({
      id: prefixedId("hlpl"),
      runId: "pending",
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      employeeName: employee.fullName,
      branchId: employee.branchId,
      leaveTypeId: annual!.id,
      leaveTypeName: annual!.name,
      availableHalfDays,
      basicSalaryCents,
      payoutCents,
      snapshotJson: JSON.stringify({ year, formula: "available leave days × basic monthly salary / 25", availableHalfDays, basicSalaryCents, packageId: assignment.package.id }),
    });
  }
  const runId = prefixedId("hlpr");
  const totalCents = lines.reduce((sum, line) => sum + line.payoutCents, 0);
  await db.insert(hrLeavePayoutRun).values({ id: runId, year, status: "draft", generatedBy: actor.userId, totalCents, employeeCount: lines.length });
  for (const line of lines) await db.insert(hrLeavePayoutLine).values({ ...line, runId });
  return getPayoutRun(runId);
}

export async function submitPayout(runId: string, actor: Principal) {
  const [run] = await db.select().from(hrLeavePayoutRun).where(eq(hrLeavePayoutRun.id, runId));
  if (!run) errors.notFound("Leave payout run");
  if (run!.status !== "draft") errors.conflict("Only a draft payout can be submitted.");
  await db.update(hrLeavePayoutRun).set({ status: "submitted", submittedBy: actor.userId, submittedAt: new Date() }).where(eq(hrLeavePayoutRun.id, runId));
  return getPayoutRun(runId);
}

export async function decidePayout(input: { runId: string; decision: "approved" | "rejected"; note?: string }, actor: Principal) {
  const [run] = await db.select().from(hrLeavePayoutRun).where(eq(hrLeavePayoutRun.id, input.runId));
  if (!run) errors.notFound("Leave payout run");
  if (run!.status !== "submitted") errors.conflict("Only a submitted payout can be approved or rejected.");
  if (input.decision === "approved") {
    await db.update(hrLeavePayoutRun).set({ status: "approved", approvedBy: actor.userId, approvedAt: new Date() }).where(eq(hrLeavePayoutRun.id, input.runId));
  } else {
    await db.update(hrLeavePayoutRun).set({ status: "draft" }).where(eq(hrLeavePayoutRun.id, input.runId));
  }
  return getPayoutRun(input.runId);
}

export async function recordPayoutPayment(input: { runId: string; reference: string }, actor: Principal) {
  const reference = input.reference.trim();
  if (reference.length < 3) errors.badRequest("Payment reference is required.");
  const [run] = await db.select().from(hrLeavePayoutRun).where(eq(hrLeavePayoutRun.id, input.runId));
  if (!run) errors.notFound("Leave payout run");
  if (run!.status !== "approved") errors.conflict("Only an approved payout can be marked paid.");
  await db.update(hrLeavePayoutRun).set({ status: "paid", paymentReference: reference, paidBy: actor.userId, paidAt: new Date() }).where(eq(hrLeavePayoutRun.id, input.runId));
  return getPayoutRun(input.runId);
}
