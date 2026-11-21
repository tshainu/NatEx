import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { centsToLkr, todayInColombo, HR_CONTROL_CLASS } from "./shared";
import { HrNavigation } from "./navigation";
import { EmployeeDetails } from "./employee-details";
import { shouldAssignSalaryPackage } from "./salary-edit";
import { Dialog } from "@/components/ui/dialog";

type EmployeeForm = {
  fullName: string;
  identityUserId: string;
  nationalId: string;
  phone: string;
  email: string;
  address: string;
  permanentAddress: string;
  currentAddress: string;
  sameAsPermanent: boolean;
  branchId: string;
  department: string;
  jobTitle: string;
  employmentType: string;
  joinedOn: string;
  endedOn: string;
  epfNumber: string;
  tin: string;
  primaryEmployment: boolean;
  overtimePolicy: "none" | "shop_office" | "natex_standard" | "custom";
  overtimeMultiplier: string;
  overtimeDivisorHours: string;
  status: "active" | "inactive";
  salaryPackageId: string;
  salaryEffectiveFrom: string;
};

const DEPARTMENT_OPTIONS = [
  "Administration",
  "Finance",
  "Human Resources",
  "Information Technology",
  "Marketing",
  "Operations",
  "Rider",
  "Rider and Collector",
  "Transport",
  "Customer Support",
  "Security",
] as const;

const JOB_TITLE_OPTIONS = [
  "CEO",
  "HR Executive",
  "Accountant",
  "Hub Manager",
  "Rider",
  "Tech Support",
  "Software Engineer",
  "Marketing Executive",
  "Customer Care Officer",
  "Driver",
  "Security",
] as const;

const emptyForm = (): EmployeeForm => ({
  fullName: "",
  identityUserId: "",
  nationalId: "",
  phone: "",
  email: "",
  address: "",
  permanentAddress: "",
  currentAddress: "",
  sameAsPermanent: true,
  branchId: "",
  department: "",
  jobTitle: "",
  employmentType: "permanent",
  joinedOn: todayInColombo(),
  endedOn: "",
  epfNumber: "",
  tin: "",
  primaryEmployment: true,
  overtimePolicy: "none",
  overtimeMultiplier: "1.5",
  overtimeDivisorHours: "240",
  status: "active",
  salaryPackageId: "",
  salaryEffectiveFrom: todayInColombo(),
});

function salaryChangeDate(joinedOn: string): string {
  const monthStart = `${todayInColombo().slice(0, 7)}-01`;
  return joinedOn > monthStart ? joinedOn : monthStart;
}

export default function HrEmployees() {
  const queryClient = useQueryClient();
  const [q, setQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [form, setForm] = React.useState<EmployeeForm>(emptyForm);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = React.useState<string | null>(null);
  const [employeeFormOpen, setEmployeeFormOpen] = React.useState(false);
  const [initialPackageId, setInitialPackageId] = React.useState("");
  const [detailSection, setDetailSection] = React.useState<"profile" | "documents" | "attendance" | "leave" | "salary">("profile");
  const [note, setNote] = React.useState<string | null>(null);

  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { q: q || undefined, status: statusFilter === "all" ? undefined : statusFilter as "active" | "inactive", limit: 500 } }) });
  const branches = useQuery({ ...orpc.hr.branchOptions.queryOptions() });
  const staffAccounts = useQuery({ ...orpc.hr.staffOptions.queryOptions() });
  const packages = useQuery({ ...orpc.hr.salaryPackages.queryOptions() });
  const editingSalary = useQuery({
    ...orpc.hr.employeePackages.queryOptions({ input: { employeeId: editingId ?? "" } }),
    enabled: Boolean(editingId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.employees.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.employeePackages.key() });
  };
  const create = useMutation({
    ...orpc.hr.createEmployee.mutationOptions(),
  });
  const save = useMutation({
    ...orpc.hr.updateEmployeeWithSalary.mutationOptions(),
    onSuccess: refresh,
  });
  const assign = useMutation({
    ...orpc.hr.assignSalaryPackage.mutationOptions(),
    onSuccess: refresh,
  });

  function setField<K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function editEmployee(employee: NonNullable<typeof employees.data>[number]) {
    setSelectedEmployeeId(null);
    setEditingId(employee.id);
    setEmployeeFormOpen(true);
    setForm({
      fullName: employee.fullName,
      identityUserId: employee.identityUserId ?? "",
      nationalId: employee.nationalId ?? "",
      phone: employee.phone ?? "",
      email: employee.email ?? "",
      address: employee.address ?? "",
      permanentAddress: employee.permanentAddress ?? employee.address ?? "",
      currentAddress: employee.currentAddress ?? employee.address ?? "",
      sameAsPermanent: (employee.currentAddress ?? employee.address ?? "") === (employee.permanentAddress ?? employee.address ?? ""),
      branchId: employee.branchId,
      department: employee.department,
      jobTitle: employee.jobTitle,
      employmentType: employee.employmentType,
      joinedOn: employee.joinedOn,
      endedOn: employee.endedOn ?? "",
      epfNumber: employee.epfNumber ?? "",
      tin: employee.tin ?? "",
      primaryEmployment: employee.primaryEmployment,
      overtimePolicy: employee.overtimePolicy as EmployeeForm["overtimePolicy"],
      overtimeMultiplier: String(employee.overtimeMultiplierBps / 10_000),
      overtimeDivisorHours: String(employee.overtimeDivisorMinutes / 60),
      status: employee.status as EmployeeForm["status"],
      salaryPackageId: "",
      salaryEffectiveFrom: salaryChangeDate(employee.joinedOn),
    });
    setNote(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNote(null);
    if (!form.sameAsPermanent && !form.currentAddress.trim()) {
      setNote("Enter the current living address or select 'Current address is the same'.");
      return;
    }
    const multiplier = Number(form.overtimeMultiplier);
    const divisorHours = Number(form.overtimeDivisorHours);
    if (!Number.isFinite(multiplier) || multiplier < 0 || !Number.isFinite(divisorHours) || divisorHours <= 0) {
      setNote("Enter a valid overtime multiplier and divisor.");
      return;
    }
    const common = {
      fullName: form.fullName.trim(),
      identityUserId: form.identityUserId || null,
      nationalId: form.nationalId || null,
      phone: form.phone || null,
      email: form.email || null,
      address: (form.currentAddress || form.permanentAddress || form.address) || null,
      permanentAddress: form.permanentAddress || null,
      currentAddress: (form.sameAsPermanent ? form.permanentAddress : form.currentAddress) || null,
      branchId: form.branchId,
      department: form.department.trim(),
      jobTitle: form.jobTitle.trim(),
      employmentType: form.employmentType as "permanent" | "probation" | "contract" | "temporary" | "casual" | "intern" | "other",
      joinedOn: form.joinedOn,
      epfNumber: form.epfNumber || null,
      tin: form.tin || null,
      primaryEmployment: form.primaryEmployment,
      overtimePolicy: form.overtimePolicy,
      overtimeMultiplierBps: Math.round(multiplier * 10_000),
      overtimeDivisorMinutes: Math.round(divisorHours * 60),
    };
    if (editingId) {
      const changedSalary = Boolean(form.salaryPackageId && shouldAssignSalaryPackage(editingSalary.data ?? [], form.salaryPackageId, form.salaryEffectiveFrom));
      let employee: Awaited<ReturnType<typeof save.mutateAsync>>;
      try {
        employee = await save.mutateAsync({
          employeeId: editingId,
          ...common,
          endedOn: form.endedOn || null,
          status: form.status,
          salaryAssignment: changedSalary
            ? { packageId: form.salaryPackageId, effectiveFrom: form.salaryEffectiveFrom }
            : undefined,
        });
      } catch {
        return;
      }
      const selectedPackage = packages.data?.find((item) => item.id === form.salaryPackageId);
      setNote(changedSalary && selectedPackage
        ? `${employee.employeeCode} was updated and ${selectedPackage.code} was assigned from ${form.salaryEffectiveFrom}. Historical payroll snapshots remain unchanged.`
        : `${employee.employeeCode} was updated. Historical payroll snapshots remain unchanged.`);
      setEditingId(null);
      setEmployeeFormOpen(false);
      setForm(emptyForm());
      setInitialPackageId("");
      refresh();
    } else {
      let employee: Awaited<ReturnType<typeof create.mutateAsync>>;
      try {
        employee = await create.mutateAsync(common);
      } catch {
        return;
      }
      let packageAssigned = !initialPackageId;
      if (initialPackageId) {
        try {
          await assign.mutateAsync({ employeeId: employee.id, packageId: initialPackageId, effectiveFrom: form.joinedOn });
          packageAssigned = true;
        } catch {
          // Keep the new employee; HR can finish the assignment from the Salary tab.
        }
      }
      const selectedPackage = packages.data?.find((item) => item.id === initialPackageId);
      setNote(packageAssigned && selectedPackage
        ? `${employee.employeeCode} was created and assigned ${selectedPackage.code} effective ${form.joinedOn}.`
        : packageAssigned
          ? `${employee.employeeCode} was added to the employee register.`
          : `${employee.employeeCode} was created, but the package assignment did not save. Review the Salary tab and assign it there.`);
      setEditingId(null);
      setEmployeeFormOpen(false);
      setForm(emptyForm());
      setInitialPackageId("");
      setSelectedEmployeeId(employee.id);
      setDetailSection(initialPackageId ? "salary" : "profile");
      refresh();
    }
  }

  const error = employees.error ?? branches.error ?? staffAccounts.error ?? packages.error ?? editingSalary.error ?? create.error ?? save.error ?? assign.error;
  const busy = create.isPending || save.isPending || assign.isPending;
  const initialPackage = packages.data?.find((pkg) => pkg.id === initialPackageId);

  return (
    <Page title="Employees" description="Confidential employee records, branch assignment and effective-dated salary package history. HR access is protected by mandatory authenticator MFA.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "The HR data could not be loaded or saved.")}</ErrorNote> : null}
      <HrNavigation />
      <Card title="Employee register" description="Only HR and administrators can read or change employee records.">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-3">
          <Input className="max-w-sm" placeholder="Search code, name, department" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className={HR_CONTROL_CLASS + " max-w-[180px]"} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </div>
          <Button onClick={() => { setEditingId(null); setForm(emptyForm()); setInitialPackageId(""); setNote(null); setEmployeeFormOpen(true); }}>Enrol New Employee</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Code</th><th className="p-2">Employee</th><th className="p-2">Official staff account</th><th className="p-2">Branch</th><th className="p-2">Department / title</th><th className="p-2">EPF</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead>
            <tbody>
              {(employees.data ?? []).map((employee) => (
                <tr key={employee.id} className="border-b border-border/60 hover:bg-muted/40">
                  <td className="p-2 font-mono">{employee.employeeCode}</td>
                  <td className="p-2 font-medium">{employee.fullName}</td>
                  <td className="p-2">{staffAccounts.data?.find((account) => account.id === employee.identityUserId)?.name ?? (employee.identityUserId ? "Linked account" : "—")}</td>
                  <td className="p-2">{(branches.data ?? []).find((b) => b.id === employee.branchId)?.name ?? employee.branchId}</td>
                  <td className="p-2">{employee.department}<span className="block text-[11px] text-muted-foreground">{employee.jobTitle}</span></td>
                  <td className="p-2 font-mono">{employee.epfNumber ?? "—"}</td>
                  <td className="p-2"><Badge variant={employee.status === "active" ? "good" : "outline"}>{employee.status}</Badge></td>
                  <td className="p-2"><div className="flex gap-1"><Button size="sm" variant="outline" aria-label={`View HR record for ${employee.employeeCode}`} onClick={() => { setSelectedEmployeeId(employee.id); setDetailSection("profile"); setNote(null); }}>View record</Button><Button size="sm" variant="ghost" aria-label={`Edit HR record for ${employee.employeeCode}`} onClick={() => editEmployee(employee)}>Edit</Button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!employees.isPending && (employees.data?.length ?? 0) === 0 ? <p className="py-8 text-center text-[13px] text-muted-foreground">No employees match this search.</p> : null}
        </div>
      </Card>

      <Dialog open={employeeFormOpen} onOpenChange={(open) => { if (!open) { setEmployeeFormOpen(false); setEditingId(null); setForm(emptyForm()); setInitialPackageId(""); } }} title={editingId ? "Edit employee" : "Enrol new employee"} description="Employee records are separate from NatEx official-user logins and Merchant portal users. Complete each outlined section before saving." className="w-[1120px]">
        <form className="space-y-5" onSubmit={submit}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-transparent bg-brand/[0.04] px-4 py-3" style={{ background: "linear-gradient(hsl(var(--card)), hsl(var(--card))) padding-box, linear-gradient(120deg, #16a085, #2ecc71, #f1c40f) border-box" }}>
            <div><p className="text-sm font-semibold text-foreground">{editingId ? "Employee profile" : "New employee profile"}</p><p className="mt-0.5 text-xs text-muted-foreground">Required fields are marked by the browser. You can complete salary assignment later.</p></div>
            {editingId ? <div className="rounded-lg border border-brand/20 bg-background px-3 py-2 text-right"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Employee number</p><p className="font-mono text-sm font-semibold text-brand">{employees.data?.find((employee) => employee.id === editingId)?.employeeCode ?? "—"}</p></div> : <span className="text-xs text-muted-foreground">Number assigned automatically on save</span>}
          </div>

          <section className="rounded-2xl border-2 border-transparent bg-background p-4 shadow-sm md:p-5" style={{ background: "linear-gradient(hsl(var(--background)), hsl(var(--background))) padding-box, linear-gradient(135deg, #16a085, #3498db, #8e44ad) border-box" }}>
            <div className="mb-4 flex items-start gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-sm font-bold text-brand">01</span><div><h3 className="text-sm font-semibold">Personal and contact details</h3><p className="mt-0.5 text-xs text-muted-foreground">Basic identity and official account information.</p></div></div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Field label="Full name"><Input required maxLength={160} value={form.fullName} onChange={(e) => setField("fullName", e.target.value)} /></Field>
              <Field label="National ID"><Input maxLength={40} value={form.nationalId} onChange={(e) => setField("nationalId", e.target.value)} /></Field>
              <Field label="Phone"><Input maxLength={30} value={form.phone} onChange={(e) => setField("phone", e.target.value)} /></Field>
              <Field label="Email"><Input type="email" maxLength={200} value={form.email} onChange={(e) => setField("email", e.target.value)} /></Field>
              <Field label="Official courier-staff login" className="md:col-span-2" hint="Optional. Link this HR record to an active official staff account. Merchant portal users are excluded.">
                <select className={HR_CONTROL_CLASS} value={form.identityUserId} onChange={(e) => setField("identityUserId", e.target.value)}><option value="">No login linked</option>{(staffAccounts.data ?? []).filter((account) => !employees.data?.some((employee) => employee.identityUserId === account.id && employee.id !== editingId)).map((account) => <option key={account.id} value={account.id}>{account.name} · {account.roles.join(" / ")} · {account.phone} · {account.status}</option>)}</select>
              </Field>
            </div>
          </section>

          <section className="rounded-2xl border-2 border-transparent bg-background p-4 shadow-sm md:p-5" style={{ background: "linear-gradient(hsl(var(--background)), hsl(var(--background))) padding-box, linear-gradient(135deg, #e67e22, #e74c3c, #9b59b6) border-box" }}>
            <div className="mb-4 flex items-start gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-sm font-bold text-brand">02</span><div><h3 className="text-sm font-semibold">Employment assignment</h3><p className="mt-0.5 text-xs text-muted-foreground">Where this employee works and what they do.</p></div></div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Field label="Branch / hub"><select required className={HR_CONTROL_CLASS} value={form.branchId} onChange={(e) => setField("branchId", e.target.value)}><option value="">Select branch or hub</option>{(branches.data ?? []).filter((branch) => branch.status === "active" || branch.id === form.branchId).map((branch) => <option key={branch.id} value={branch.id}>{branch.name} · {branch.type}{branch.status === "active" ? "" : " · inactive"}</option>)}</select></Field>
              <Field label="Department"><select required className={HR_CONTROL_CLASS} value={form.department} onChange={(e) => setField("department", e.target.value)}><option value="">Select department</option>{form.department && !DEPARTMENT_OPTIONS.includes(form.department as typeof DEPARTMENT_OPTIONS[number]) ? <option value={form.department}>{form.department} · existing</option> : null}{DEPARTMENT_OPTIONS.map((department) => <option key={department} value={department}>{department}</option>)}</select></Field>
              <Field label="Job title" hint="Select the employee's designation. NOS access is assigned separately to the linked login."><select required className={HR_CONTROL_CLASS} value={form.jobTitle} onChange={(e) => setField("jobTitle", e.target.value)}><option value="">Select job title</option>{form.jobTitle && !JOB_TITLE_OPTIONS.includes(form.jobTitle as typeof JOB_TITLE_OPTIONS[number]) ? <option value={form.jobTitle}>{form.jobTitle} · existing</option> : null}{JOB_TITLE_OPTIONS.map((jobTitle) => <option key={jobTitle} value={jobTitle}>{jobTitle}</option>)}</select></Field>
              <Field label="Employment type"><select className={HR_CONTROL_CLASS} value={form.employmentType} onChange={(e) => setField("employmentType", e.target.value)}>{(["permanent", "probation", "contract", "temporary", "casual", "intern", "other"] as const).map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
              <Field label="Joined on"><Input type="date" required value={form.joinedOn} onChange={(e) => setField("joinedOn", e.target.value)} /></Field>
              {editingId ? <Field label="End date"><Input type="date" value={form.endedOn} onChange={(e) => setField("endedOn", e.target.value)} /></Field> : null}
              {editingId ? <Field label="Employment status"><select className={HR_CONTROL_CLASS} value={form.status} onChange={(e) => setField("status", e.target.value as EmployeeForm["status"])}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field> : null}
            </div>
          </section>

          <section className="rounded-2xl border-2 border-transparent bg-background p-4 shadow-sm md:p-5" style={{ background: "linear-gradient(hsl(var(--background)), hsl(var(--background))) padding-box, linear-gradient(135deg, #2980b9, #16a085, #27ae60) border-box" }}>
            <div className="mb-4 flex items-start gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-sm font-bold text-brand">03</span><div><h3 className="text-sm font-semibold">Compliance and payroll</h3><p className="mt-0.5 text-xs text-muted-foreground">Statutory identifiers, overtime, and salary setup.</p></div></div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Field label="EPF member number"><Input maxLength={50} value={form.epfNumber} onChange={(e) => setField("epfNumber", e.target.value)} /></Field>
              <Field label="Taxpayer identification number"><Input maxLength={50} value={form.tin} onChange={(e) => setField("tin", e.target.value)} /></Field>

              <Field label="Overtime classification" className="md:col-span-2" hint="No overtime is paid until a rule is configured."><select className={HR_CONTROL_CLASS} value={form.overtimePolicy} onChange={(e) => setField("overtimePolicy", e.target.value as EmployeeForm["overtimePolicy"])}><option value="none">Not configured</option><option value="natex_standard">NatEx standard 1x (basic ÷ 25 ÷ 8)</option><option value="shop_office">Shop & Office (1.5×)</option><option value="custom">Custom validated rule</option></select></Field>
              {form.overtimePolicy === "custom" ? <><Field label="Custom overtime multiplier"><Input type="number" min="0.1" max="5" step="0.01" value={form.overtimeMultiplier} onChange={(e) => setField("overtimeMultiplier", e.target.value)} /></Field><Field label="Monthly hourly divisor"><Input type="number" min="1" max="2400" step="1" value={form.overtimeDivisorHours} onChange={(e) => setField("overtimeDivisorHours", e.target.value)} /></Field></> : null}
              {editingId ? <><Field label="New salary package" className="md:col-span-2" hint="Changing packages preserves effective-dated salary history."><select className={HR_CONTROL_CLASS} value={form.salaryPackageId} onChange={(e) => setField("salaryPackageId", e.target.value)}><option value="">Keep current salary history</option>{(packages.data ?? []).filter((pkg) => pkg.active).map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.code} · {pkg.name} · LKR {centsToLkr(pkg.basePayCents)} / {pkg.payBasis}</option>)}</select></Field><Field label="Salary effective from" hint="Package changes start on the 1st of a month. A new employee's first package may start on the joined date."><Input type="date" required={Boolean(form.salaryPackageId)} value={form.salaryEffectiveFrom} onChange={(e) => setField("salaryEffectiveFrom", e.target.value)} /></Field></> : <Field label="Starting salary package" className="md:col-span-2" hint="Optional starting salary package."><select className={HR_CONTROL_CLASS} value={initialPackageId} onChange={(e) => setInitialPackageId(e.target.value)}><option value="">Create employee without a package</option>{(packages.data ?? []).filter((pkg) => pkg.active).map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.code} · {pkg.name} · LKR {centsToLkr(pkg.basePayCents)} / {pkg.payBasis}</option>)}</select></Field>}
            </div>
            {editingSalary.isPending ? <p className="mt-3 text-xs text-muted-foreground">Loading salary history…</p> : null}
            {!editingId && initialPackage ? <div className="mt-4 rounded-xl border border-brand/25 bg-brand/5 p-3 text-xs"><p className="font-semibold">{initialPackage.code} · {initialPackage.name}</p><p className="mt-1 text-muted-foreground">Base: LKR {centsToLkr(initialPackage.basePayCents)} per {initialPackage.payBasis} · {initialPackage.items.length} recurring component(s).</p></div> : null}
          </section>

          <section className="rounded-2xl border-2 border-transparent bg-background p-4 shadow-sm md:p-5" style={{ background: "linear-gradient(hsl(var(--background)), hsl(var(--background))) padding-box, linear-gradient(135deg, #8e44ad, #d35400, #f39c12) border-box" }}>
            <div className="mb-4 flex items-start gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-sm font-bold text-brand">04</span><div><h3 className="text-sm font-semibold">Address details</h3><p className="mt-0.5 text-xs text-muted-foreground">Keep the registered address and current living address accurate for HR records.</p></div></div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Permanent address" hint="Long-term or registered home address."><Textarea value={form.permanentAddress} onChange={(e) => { setField("permanentAddress", e.target.value); if (form.sameAsPermanent) setField("currentAddress", e.target.value); }} maxLength={500} /></Field>
              <div className="space-y-3"><label className="flex items-start gap-2 rounded-xl border border-brand/20 bg-brand/[0.04] p-3 text-xs"><input type="checkbox" checked={form.sameAsPermanent} onChange={(e) => { const checked = e.target.checked; setField("sameAsPermanent", checked); if (checked) setField("currentAddress", form.permanentAddress); }} /><span><span className="block font-medium">Current address is the same</span><span className="mt-0.5 block text-muted-foreground">Use the permanent address as the living address.</span></span></label>{!form.sameAsPermanent ? <Field label="Current living address" hint="Required when the employee currently lives elsewhere."><Textarea value={form.currentAddress} onChange={(e) => setField("currentAddress", e.target.value)} maxLength={500} /></Field> : <div className="rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">Current living address will be saved from the permanent address.</div>}</div>
            </div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-transparent bg-muted/20 p-4" style={{ background: "linear-gradient(hsl(var(--muted) / 0.2), hsl(var(--muted) / 0.2)) padding-box, linear-gradient(120deg, #f1c40f, #e67e22, #16a085) border-box" }}><div className="text-xs text-muted-foreground">Review the sections above before saving this confidential HR record.</div><div className="flex flex-wrap gap-2"><Button type="submit" pending={busy}>{editingId ? "Save employee" : "Create employee"}</Button>{!editingId && !(packages.data ?? []).some((pkg) => pkg.active) ? <a className="self-center text-xs font-medium text-brand underline" href="/hr/packages">Create a salary package first</a> : null}{editingId ? <Button type="button" variant="outline" onClick={() => { setEmployeeFormOpen(false); setEditingId(null); setForm(emptyForm()); setInitialPackageId(""); }}>Cancel edit</Button> : null}</div></div>
        </form>
      </Dialog>

      {selectedEmployeeId ? (() => {
        const selected = employees.data?.find((employee) => employee.id === selectedEmployeeId);
        if (!selected) return null;
        return <Dialog open onOpenChange={(open) => { if (!open) setSelectedEmployeeId(null); }} title={`${selected.employeeCode} · ${selected.fullName}`} description={`${selected.department} · ${selected.jobTitle}`} className="w-[1000px]"><EmployeeDetails key={`${selected.id}-${detailSection}`} employee={selected} branchName={(branches.data ?? []).find((branch) => branch.id === selected.branchId)?.name ?? selected.branchId} packages={packages.data ?? []} initialSection={detailSection} onClose={() => setSelectedEmployeeId(null)} /></Dialog>;
      })() : null}
    </Page>
  );
}
