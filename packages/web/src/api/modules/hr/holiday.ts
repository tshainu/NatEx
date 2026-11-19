import { and, asc, eq } from "drizzle-orm";
import { db } from "../../database";
import { hrHoliday } from "../../database/schema/hr";
import { getBranch } from "../identity/service";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { isValidIsoDate } from "./validation";

export type HolidayRow = typeof hrHoliday.$inferSelect;

function assertDate(value: string) {
  if (!isValidIsoDate(value)) errors.badRequest("Holiday date must be a real calendar date in YYYY-MM-DD format.");
}

export async function listHolidays(input: { year?: number; active?: boolean } = {}) {
  const rows = await db.select().from(hrHoliday).orderBy(asc(hrHoliday.holidayDate), asc(hrHoliday.name));
  return rows.filter((row) =>
    (input.year === undefined || row.holidayDate.startsWith(`${input.year}-`)) &&
    (input.active === undefined || row.active === input.active),
  );
}

export async function saveHoliday(input: {
  id?: string;
  holidayDate: string;
  name: string;
  scope: "company" | "hub" | "branch";
  scopeId?: string;
  otAllowed: boolean;
  compulsoryLeave: boolean;
  active: boolean;
}, actor: Principal) {
  assertDate(input.holidayDate);
  const name = input.name.trim();
  if (name.length < 2) errors.badRequest("Holiday name is required.");
  if (input.scope === "company" && input.scopeId) errors.badRequest("Company holidays cannot have a scope ID.");
  if (input.scope !== "company" && !input.scopeId) errors.badRequest("Hub and branch holidays require a scope ID.");
  if (input.scopeId) {
    const branch = await getBranch(input.scopeId);
    if (!branch) errors.notFound("Holiday scope");
    if (input.scope === "hub" && branch!.type !== "hub") errors.badRequest("Holiday hub scope must reference a hub.");
    if (input.scope === "branch" && branch!.type !== "branch") errors.badRequest("Holiday branch scope must reference a branch.");
  }
  const values = {
    holidayDate: input.holidayDate,
    name,
    scope: input.scope,
    scopeId: input.scopeId ?? null,
    otAllowed: input.otAllowed,
    compulsoryLeave: input.compulsoryLeave,
    active: input.active,
    updatedBy: actor.userId,
    updatedAt: new Date(),
  };
  if (input.id) {
    const [existing] = await db.select().from(hrHoliday).where(eq(hrHoliday.id, input.id));
    if (!existing) errors.notFound("Holiday");
    const [row] = await db.update(hrHoliday).set(values).where(eq(hrHoliday.id, input.id)).returning();
    return row!;
  }
  const [row] = await db.insert(hrHoliday).values({
    id: prefixedId("hhd"),
    ...values,
    createdBy: actor.userId,
  }).returning();
  return row!;
}

/** Most-specific active holiday rule for an employee branch. */
export async function applicableHoliday(holidayDate: string, branchId: string | null | undefined) {
  assertDate(holidayDate);
  const rows = await db.select().from(hrHoliday).where(and(eq(hrHoliday.holidayDate, holidayDate), eq(hrHoliday.active, true)));
  const branch = branchId ? await getBranch(branchId) : null;
  const hubId = branch?.type === "branch" ? branch.parentHubId : branch?.id;
  const candidates = rows.filter((row) =>
    row.scope === "company" ||
    (row.scope === "branch" && row.scopeId === branchId) ||
    (row.scope === "hub" && row.scopeId === hubId),
  );
  candidates.sort((a, b) => ({ branch: 3, hub: 2, company: 1 }[b.scope]! - ({ branch: 3, hub: 2, company: 1 }[a.scope]!)));
  return candidates[0] ?? null;
}
