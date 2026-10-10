import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * MODULE: HR and payroll. All money is integer cents; dates are Colombo business
 * dates encoded as ISO YYYY-MM-DD strings. Only api/modules/hr/* reads these
 * tables. Employee records are intentionally separate from identity users and
 * Merchant portal users.
 */
export const hrEmployee = sqliteTable(
  "hr_employee",
  {
    id: text("id").primaryKey(),
    employeeCode: text("employee_code").notNull().unique(),
    fullName: text("full_name").notNull(),
    nationalId: text("national_id"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    branchId: text("branch_id").notNull(),
    department: text("department").notNull(),
    jobTitle: text("job_title").notNull(),
    employmentType: text("employment_type").notNull(),
    joinedOn: text("joined_on").notNull(),
    endedOn: text("ended_on"),
    status: text("status").notNull().default("active"),
    epfNumber: text("epf_number"),
    tin: text("tin"),
    primaryEmployment: integer("primary_employment", { mode: "boolean" }).notNull().default(true),
    /** none | shop_office | custom */
    overtimePolicy: text("overtime_policy").notNull().default("none"),
    overtimeMultiplierBps: integer("overtime_multiplier_bps").notNull().default(15000),
    /** Hourly divisor in minutes; Shop/Office monthly rate uses 30 × 8 × 60. */
    overtimeDivisorMinutes: integer("overtime_divisor_minutes").notNull().default(14400),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_employee_branch_idx").on(t.branchId), index("hr_employee_status_idx").on(t.status)],
);

export const hrSalaryPackage = sqliteTable(
  "hr_salary_package",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    /** monthly | daily | hourly */
    payBasis: text("pay_basis").notNull().default("monthly"),
    basePayCents: integer("base_pay_cents").notNull(),
    baseEpfEligible: integer("base_epf_eligible", { mode: "boolean" }).notNull().default(true),
    baseEtfEligible: integer("base_etf_eligible", { mode: "boolean" }).notNull().default(true),
    baseApitTaxable: integer("base_apit_taxable", { mode: "boolean" }).notNull().default(true),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_salary_package_active_idx").on(t.active)],
);

export const hrSalaryPackageItem = sqliteTable(
  "hr_salary_package_item",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull().references(() => hrSalaryPackage.id),
    label: text("label").notNull(),
    /** earning | deduction */
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    epfEligible: integer("epf_eligible", { mode: "boolean" }).notNull().default(false),
    etfEligible: integer("etf_eligible", { mode: "boolean" }).notNull().default(false),
    apitTaxable: integer("apit_taxable", { mode: "boolean" }).notNull().default(false),
    overtimeEligible: integer("overtime_eligible", { mode: "boolean" }).notNull().default(false),
    /** full_period | unpaid_leave_prorated */
    proration: text("proration").notNull().default("full_period"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("hr_package_item_package_idx").on(t.packageId)],
);

export const hrEmployeePackage = sqliteTable(
  "hr_employee_package",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull().references(() => hrEmployee.id),
    packageId: text("package_id").notNull().references(() => hrSalaryPackage.id),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_employee_package_employee_idx").on(t.employeeId, t.effectiveFrom)],
);

export const hrTimesheet = sqliteTable(
  "hr_timesheet",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull().references(() => hrEmployee.id),
    workDate: text("work_date").notNull(),
    regularMinutes: integer("regular_minutes").notNull().default(0),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    /** present | absent | leave | off_duty; leave balances remain managed separately. */
    attendanceStatus: text("attendance_status").notNull().default("present"),
    note: text("note"),
    source: text("source").notNull().default("manual"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("hr_timesheet_employee_date_uq").on(t.employeeId, t.workDate),
    index("hr_timesheet_date_idx").on(t.workDate),
  ],
);

export const hrLeaveType = sqliteTable(
  "hr_leave_type",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    paid: integer("paid", { mode: "boolean" }).notNull(),
    /** Entitlement uses half-days; HR configures policy for the covered staff. */
    annualEntitlementHalfDays: integer("annual_entitlement_half_days").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_leave_type_active_idx").on(t.active)],
);

export const hrLeaveRequest = sqliteTable(
  "hr_leave_request",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull().references(() => hrEmployee.id),
    leaveTypeId: text("leave_type_id").notNull().references(() => hrLeaveType.id),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    halfDays: integer("half_days").notNull(),
    reason: text("reason").notNull(),
    /** pending | approved | rejected | cancelled */
    status: text("status").notNull().default("pending"),
    createdBy: text("created_by").notNull(),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_leave_employee_date_idx").on(t.employeeId, t.startsOn), index("hr_leave_status_idx").on(t.status)],
);

export const hrLeaveAdjustment = sqliteTable(
  "hr_leave_adjustment",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull().references(() => hrEmployee.id),
    leaveTypeId: text("leave_type_id").notNull().references(() => hrLeaveType.id),
    leaveYear: integer("leave_year").notNull(),
    halfDaysDelta: integer("half_days_delta").notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_leave_adjust_employee_year_idx").on(t.employeeId, t.leaveYear)],
);

export const hrApitSchedule = sqliteTable(
  "hr_apit_schedule",
  {
    id: text("id").primaryKey(),
    taxYear: text("tax_year").notNull(),
    version: text("version").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to").notNull(),
    scheduleJson: text("schedule_json").notNull(),
    /** unverified | validated | retired */
    status: text("status").notNull().default("unverified"),
    accountantName: text("accountant_name"),
    validationReference: text("validation_reference"),
    validatedBy: text("validated_by"),
    validatedAt: integer("validated_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("hr_apit_tax_year_version_uq").on(t.taxYear, t.version), index("hr_apit_schedule_status_idx").on(t.status)],
);

export const hrPayrollRun = sqliteTable(
  "hr_payroll_run",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    /** draft | submitted | approved | paid | cancelled */
    status: text("status").notNull().default("draft"),
    apitScheduleId: text("apit_schedule_id").notNull().references(() => hrApitSchedule.id),
    createdBy: text("created_by").notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    paymentReference: text("payment_reference"),
    paidBy: text("paid_by"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    cancelReason: text("cancel_reason"),
    employeeCount: integer("employee_count").notNull().default(0),
    grossCents: integer("gross_cents").notNull().default(0),
    employeeEpfCents: integer("employee_epf_cents").notNull().default(0),
    employerEpfCents: integer("employer_epf_cents").notNull().default(0),
    employerEtfCents: integer("employer_etf_cents").notNull().default(0),
    apitCents: integer("apit_cents").notNull().default(0),
    otherDeductionsCents: integer("other_deductions_cents").notNull().default(0),
    netCents: integer("net_cents").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("hr_payroll_period_idx").on(t.periodStart, t.periodEnd),
    index("hr_payroll_status_idx").on(t.status),
  ],
);

export const hrPayrollLine = sqliteTable(
  "hr_payroll_line",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => hrPayrollRun.id),
    employeeId: text("employee_id").notNull().references(() => hrEmployee.id),
    employeeCode: text("employee_code").notNull(),
    employeeName: text("employee_name").notNull(),
    epfNumber: text("epf_number"),
    payBasis: text("pay_basis").notNull(),
    grossCents: integer("gross_cents").notNull(),
    epfBaseCents: integer("epf_base_cents").notNull(),
    etfBaseCents: integer("etf_base_cents").notNull(),
    apitBaseCents: integer("apit_base_cents").notNull(),
    employeeEpfCents: integer("employee_epf_cents").notNull(),
    employerEpfCents: integer("employer_epf_cents").notNull(),
    employerEtfCents: integer("employer_etf_cents").notNull(),
    apitCents: integer("apit_cents").notNull(),
    otherDeductionsCents: integer("other_deductions_cents").notNull(),
    netCents: integer("net_cents").notNull(),
    /** Calculation and salary-component snapshot; approved payslips never recalculate. */
    breakdownJson: text("breakdown_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("hr_payroll_line_employee_uq").on(t.runId, t.employeeId), index("hr_payroll_line_run_idx").on(t.runId)],
);

export const hrEmployeeDocument = sqliteTable(
  "hr_employee_document",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull().references(() => hrEmployee.id),
    category: text("category").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Opaque S3 object reference; signed URLs are minted only when HR views it. */
    storageRef: text("storage_ref").notNull().unique(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("hr_employee_document_employee_idx").on(t.employeeId, t.createdAt)],
);
