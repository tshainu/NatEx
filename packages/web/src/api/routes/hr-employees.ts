import { z } from "zod";
import { hrProc, mutate } from "../middleware/pipeline";
import * as hr from "../modules/hr/service";
import * as identity from "../modules/identity/service";
import { errors } from "../shared/errors";
import { isValidIsoDate } from "../modules/hr/validation";

const employeeCode = z.string().trim().min(2).max(20);
const isoDay = z.string().refine(isValidIsoDate, "Use a real calendar date in YYYY-MM-DD format.");
const employmentType = z.enum(["permanent", "probation", "contract", "temporary", "casual", "intern", "other"]);
const overtimePolicy = z.enum(["none", "shop_office", "custom"]);

const employeeFields = z.object({
  employeeCode,
  fullName: z.string().trim().min(2).max(160),
  nationalId: z.string().trim().max(40).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(200).nullish(),
  address: z.string().trim().max(500).nullish(),
  branchId: z.string().min(1),
  department: z.string().trim().min(2).max(100),
  jobTitle: z.string().trim().min(2).max(120),
  employmentType,
  joinedOn: isoDay,
  epfNumber: z.string().trim().max(50).nullish(),
  tin: z.string().trim().max(50).nullish(),
  primaryEmployment: z.boolean().default(true),
  overtimePolicy: overtimePolicy.default("none"),
  overtimeMultiplierBps: z.number().int().min(0).max(50_000).default(15_000),
  overtimeDivisorMinutes: z.number().int().min(1).max(144_000).default(14_400),
});

const packageItem = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["earning", "deduction"]),
  amountCents: z.number().int().positive().max(10_000_000_000),
  epfEligible: z.boolean().default(false),
  etfEligible: z.boolean().default(false),
  apitTaxable: z.boolean().default(false),
  overtimeEligible: z.boolean().default(false),
  proration: z.enum(["full_period", "unpaid_leave_prorated"]).default("full_period"),
});
const packageFields = z.object({
  code: z.string().trim().min(2).max(20),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullish(),
  payBasis: z.enum(["monthly", "daily", "hourly"]),
  basePayCents: z.number().int().positive().max(10_000_000_000),
  baseEpfEligible: z.boolean().default(true),
  baseEtfEligible: z.boolean().default(true),
  baseApitTaxable: z.boolean().default(true),
  items: z.array(packageItem).max(100).default([]),
});

async function assertBranch(branchId: string): Promise<void> {
  const branch = await identity.getBranch(branchId);
  if (!branch) errors.badRequest("Select a valid NatEx branch or hub.");
}

export const branchOptions = hrProc.handler(() => identity.listBranches());

export const employees = hrProc
  .input(z.object({ q: z.string().max(100).optional(), status: z.enum(["active", "inactive"]).optional(), limit: z.number().int().min(1).max(5000).default(500) }))
  .handler(({ input }) => hr.listEmployees(input));

export const createEmployee = hrProc.input(employeeFields).handler(async ({ input, context }) => {
  await assertBranch(input.branchId);
  return mutate(context, input, {
    route: "hr.createEmployee",
    entity: "hr_employee",
    entityId: (row) => (row as { id: string }).id,
    action: "hr.employee_created",
  }, () => hr.createEmployee(input, context.principal));
});

export const updateEmployee = hrProc.input(z.object({
  employeeId: z.string().min(1),
  employeeCode: employeeCode.optional(),
  fullName: z.string().trim().min(2).max(160).optional(),
  nationalId: z.string().trim().max(40).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(200).nullish(),
  address: z.string().trim().max(500).nullish(),
  branchId: z.string().min(1).optional(),
  department: z.string().trim().min(2).max(100).optional(),
  jobTitle: z.string().trim().min(2).max(120).optional(),
  employmentType: employmentType.optional(),
  joinedOn: isoDay.optional(),
  endedOn: isoDay.nullish(),
  status: z.enum(["active", "inactive"]).optional(),
  epfNumber: z.string().trim().max(50).nullish(),
  tin: z.string().trim().max(50).nullish(),
  primaryEmployment: z.boolean().optional(),
  overtimePolicy: overtimePolicy.optional(),
  overtimeMultiplierBps: z.number().int().min(0).max(50_000).optional(),
  overtimeDivisorMinutes: z.number().int().min(1).max(144_000).optional(),
})).handler(async ({ input, context }) => {
  if (input.branchId) await assertBranch(input.branchId);
  const { employeeId, ...patch } = input;
  return mutate(context, input, {
    route: "hr.updateEmployee",
    entity: "hr_employee",
    entityId: () => employeeId,
    action: "hr.employee_updated",
  }, () => hr.updateEmployee(employeeId, patch, context.principal));
});

export const salaryPackages = hrProc.handler(() => hr.listSalaryPackages());
export const createSalaryPackage = hrProc.input(packageFields).handler(({ input, context }) =>
  mutate(context, input, {
    route: "hr.createSalaryPackage",
    entity: "hr_salary_package",
    entityId: (row) => (row as { id: string }).id,
    action: "hr.salary_package_created",
  }, () => hr.createSalaryPackage(input, context.principal)),
);
export const updateSalaryPackage = hrProc.input(z.object({ packageId: z.string().min(1), ...packageFields.shape })).handler(({ input, context }) => {
  const { packageId, ...fields } = input;
  return mutate(context, input, {
    route: "hr.updateSalaryPackage",
    entity: "hr_salary_package",
    entityId: () => packageId,
    action: "hr.salary_package_updated",
  }, () => hr.updateSalaryPackage(packageId, fields));
});

export const assignSalaryPackage = hrProc.input(z.object({ employeeId: z.string().min(1), packageId: z.string().min(1), effectiveFrom: isoDay })).handler(({ input, context }) =>
  mutate(context, input, {
    route: "hr.assignSalaryPackage",
    entity: "hr_employee_package",
    entityId: (row) => (row as { id: string }).id,
    action: "hr.salary_package_assigned",
  }, () => hr.assignSalaryPackage(input, context.principal)),
);

export const employeePackages = hrProc.input(z.object({ employeeId: z.string().min(1) })).handler(({ input }) => hr.listEmployeePackages(input.employeeId));

export const hrEmployees = {
  branchOptions,
  employees,
  createEmployee,
  updateEmployee,
  salaryPackages,
  createSalaryPackage,
  updateSalaryPackage,
  assignSalaryPackage,
  employeePackages,
};
