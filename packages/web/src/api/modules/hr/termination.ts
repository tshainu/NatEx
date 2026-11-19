import { and, desc, eq } from "drizzle-orm";
import { db } from "../../database";
import { hrEmployee, hrTermination } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { isValidIsoDate } from "./validation";

export const TERMINATION_TYPES = ["resignation", "retirement", "end_of_contract", "probation_not_confirmed", "redundancy", "performance", "misconduct", "absence_abandonment", "medical", "mutual_separation", "death_in_service", "other"] as const;
export const TERMINATION_STATUSES = ["draft", "submitted", "approved", "rejected", "completed"] as const;

function parseChecklist(value: string): Record<string, boolean> {
  try { return JSON.parse(value) as Record<string, boolean>; } catch { return {}; }
}

export async function listTerminations() {
  const rows = await db.select({ termination: hrTermination, employee: hrEmployee })
    .from(hrTermination).innerJoin(hrEmployee, eq(hrEmployee.id, hrTermination.employeeId))
    .orderBy(desc(hrTermination.createdAt));
  return rows.map(({ termination, employee }) => ({ termination: { ...termination, checklist: parseChecklist(termination.checklistJson) }, employee: { id: employee.id, employeeCode: employee.employeeCode, fullName: employee.fullName, department: employee.department, branchId: employee.branchId, status: employee.status } }));
}

export async function createTermination(input: { employeeId: string; terminationType: string; noticeGivenOn?: string | null; lastWorkingOn: string; reason: string; notes?: string | null; rehireDecision: string; checklist: Record<string, boolean> }, principal: Principal) {
  if (!TERMINATION_TYPES.includes(input.terminationType as typeof TERMINATION_TYPES[number])) errors.badRequest("Select a valid termination type.");
  if (!isValidIsoDate(input.lastWorkingOn)) errors.badRequest("Last working date must be a real calendar date.");
  if (input.noticeGivenOn && !isValidIsoDate(input.noticeGivenOn)) errors.badRequest("Notice date must be a real calendar date.");
  const employee = await db.select({ id: hrEmployee.id, status: hrEmployee.status }).from(hrEmployee).where(eq(hrEmployee.id, input.employeeId)).limit(1);
  if (!employee.length) errors.notFound("Employee");
  if (employee[0]!.status !== "active") errors.conflict("Only active employees can start a termination request.");
  const existing = await db.select({ id: hrTermination.id }).from(hrTermination).where(and(eq(hrTermination.employeeId, input.employeeId), eq(hrTermination.status, "submitted"))).limit(1);
  if (existing.length) errors.conflict("This employee already has a termination request awaiting approval.");
  const [row] = await db.insert(hrTermination).values({ id: prefixedId("term"), employeeId: input.employeeId, terminationType: input.terminationType, noticeGivenOn: input.noticeGivenOn || null, lastWorkingOn: input.lastWorkingOn, reason: input.reason.trim(), notes: input.notes?.trim() || null, rehireDecision: input.rehireDecision, checklistJson: JSON.stringify(input.checklist), createdBy: principal.userId }).returning();
  return row;
}

export async function submitTermination(id: string, principal: Principal) {
  const [row] = await db.update(hrTermination).set({ status: "submitted", submittedBy: principal.userId, updatedAt: new Date() }).where(and(eq(hrTermination.id, id), eq(hrTermination.status, "draft"))).returning();
  if (!row) errors.conflict("Only a draft termination request can be submitted.");
  return row;
}

export async function decideTermination(input: { id: string; decision: "approved" | "rejected"; decisionNote: string }, principal: Principal) {
  const [row] = await db.update(hrTermination).set({ status: input.decision, decidedBy: principal.userId, decisionNote: input.decisionNote.trim(), updatedAt: new Date() }).where(and(eq(hrTermination.id, input.id), eq(hrTermination.status, "submitted"))).returning();
  if (!row) errors.conflict("Only a submitted termination request can be approved or rejected.");
  return row;
}

export async function completeTermination(id: string, principal: Principal) {
  const [row] = await db.update(hrTermination).set({ status: "completed", updatedAt: new Date() }).where(and(eq(hrTermination.id, id), eq(hrTermination.status, "approved"))).returning();
  if (!row) errors.conflict("Only an approved termination can be completed.");
  await db.update(hrEmployee).set({ status: "inactive", endedOn: row.lastWorkingOn, updatedBy: principal.userId, updatedAt: new Date() }).where(eq(hrEmployee.id, row.employeeId));
  return row;
}

export async function updateChecklist(input: { id: string; checklist: Record<string, boolean> }) {
  const [row] = await db.update(hrTermination).set({ checklistJson: JSON.stringify(input.checklist), updatedAt: new Date() }).where(eq(hrTermination.id, input.id)).returning();
  if (!row) errors.notFound("Termination request");
  return row;
}
