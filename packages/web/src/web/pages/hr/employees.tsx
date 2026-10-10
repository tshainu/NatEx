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

type EmployeeForm = {
  employeeCode: string;
  fullName: string;
  nationalId: string;
  phone: string;
  email: string;
  address: string;
  branchId: string;
  department: string;
  jobTitle: string;
  employmentType: string;
  joinedOn: string;
  endedOn: string;
  epfNumber: string;
  tin: string;
  primaryEmployment: boolean;
  overtimePolicy: "none" | "shop_office" | "custom";
  overtimeMultiplier: string;
  overtimeDivisorHours: string;
  status: "active" | "inactive";
};

const emptyForm = (): EmployeeForm => ({
  employeeCode: "",
  fullName: "",
  nationalId: "",
  phone: "",
  email: "",
  address: "",
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
});

export default function HrEmployees() {
  const queryClient = useQueryClient();
  const [q, setQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [form, setForm] = React.useState<EmployeeForm>(emptyForm);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = React.useState<string | null>(null);
  const [initialPackageId, setInitialPackageId] = React.useState("");
  const [detailSection, setDetailSection] = React.useState<"profile" | "documents" | "attendance" | "leave" | "salary">("profile");
  const [note, setNote] = React.useState<string | null>(null);

  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { q: q || undefined, status: statusFilter === "all" ? undefined : statusFilter as "active" | "inactive", limit: 500 } }) });
  const branches = useQuery({ ...orpc.hr.branchOptions.queryOptions() });
  const packages = useQuery({ ...orpc.hr.salaryPackages.queryOptions() });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.employees.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.employeePackages.key() });
  };
  const create = useMutation({
    ...orpc.hr.createEmployee.mutationOptions(),
  });
  const update = useMutation({
    ...orpc.hr.updateEmployee.mutationOptions(),
    onSuccess: (employee) => {
      setNote(`${employee.employeeCode} was updated. Historical payroll snapshots remain unchanged.`);
      setEditingId(null);
      setForm(emptyForm());
      setInitialPackageId("");
      refresh();
    },
  });
  const assign = useMutation({
    ...orpc.hr.assignSalaryPackage.mutationOptions(),
    onSuccess: refresh,
  });

  function setField<K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function editEmployee(employee: NonNullable<typeof employees.data>[number]) {
    setEditingId(employee.id);
    setForm({
      employeeCode: employee.employeeCode,
      fullName: employee.fullName,
      nationalId: employee.nationalId ?? "",
      phone: employee.phone ?? "",
      email: employee.email ?? "",
      address: employee.address ?? "",
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
    });
    setSelectedEmployeeId(employee.id);
    setNote(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNote(null);
    const multiplier = Number(form.overtimeMultiplier);
    const divisorHours = Number(form.overtimeDivisorHours);
    if (!Number.isFinite(multiplier) || multiplier < 0 || !Number.isFinite(divisorHours) || divisorHours <= 0) {
      setNote("Enter a valid overtime multiplier and divisor.");
      return;
    }
    const common = {
      employeeCode: form.employeeCode.trim(),
      fullName: form.fullName.trim(),
      nationalId: form.nationalId || null,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
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
      update.mutate({ employeeId: editingId, ...common, endedOn: form.endedOn || null, status: form.status });
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
      setForm(emptyForm());
      setInitialPackageId("");
      setSelectedEmployeeId(employee.id);
      setDetailSection(initialPackageId ? "salary" : "profile");
      refresh();
    }
  }

  const error = employees.error ?? branches.error ?? packages.error ?? create.error ?? update.error ?? assign.error;
  const busy = create.isPending || update.isPending || assign.isPending;
  const initialPackage = packages.data?.find((pkg) => pkg.id === initialPackageId);

  return (
    <Page title="Employees" description="Confidential employee records, branch assignment and effective-dated salary package history. HR access is protected by mandatory authenticator MFA.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "The HR data could not be loaded or saved.")}</ErrorNote> : null}
      <HrNavigation />
      <Card title={editingId ? "Edit employee" : "Add employee"} description="Employee records are separate from NatEx official-user logins and Merchant portal users.">
        <form className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" onSubmit={submit}>
          <Field label="Employee code"><Input required maxLength={20} value={form.employeeCode} onChange={(e) => setField("employeeCode", e.target.value.toUpperCase())} /></Field>
          <Field label="Full name"><Input required maxLength={160} value={form.fullName} onChange={(e) => setField("fullName", e.target.value)} /></Field>
          <Field label="National ID"><Input maxLength={40} value={form.nationalId} onChange={(e) => setField("nationalId", e.target.value)} /></Field>
          <Field label="Phone"><Input maxLength={30} value={form.phone} onChange={(e) => setField("phone", e.target.value)} /></Field>
          <Field label="Email"><Input type="email" maxLength={200} value={form.email} onChange={(e) => setField("email", e.target.value)} /></Field>
          <Field label="Branch / hub">
            <select required className={HR_CONTROL_CLASS} value={form.branchId} onChange={(e) => setField("branchId", e.target.value)}>
              <option value="">Select branch or hub</option>
              {(branches.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name} · {branch.type}</option>)}
            </select>
          </Field>
          <Field label="Department"><Input required value={form.department} onChange={(e) => setField("department", e.target.value)} /></Field>
          <Field label="Job title"><Input required value={form.jobTitle} onChange={(e) => setField("jobTitle", e.target.value)} /></Field>
          <Field label="Employment type">
            <select className={HR_CONTROL_CLASS} value={form.employmentType} onChange={(e) => setField("employmentType", e.target.value)}>
              {(["permanent", "probation", "contract", "temporary", "casual", "intern", "other"] as const).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </Field>
          <Field label="Joined on"><Input type="date" required value={form.joinedOn} onChange={(e) => setField("joinedOn", e.target.value)} /></Field>
          {editingId ? <Field label="End date"><Input type="date" value={form.endedOn} onChange={(e) => setField("endedOn", e.target.value)} /></Field> : null}
          <Field label="EPF member number"><Input maxLength={50} value={form.epfNumber} onChange={(e) => setField("epfNumber", e.target.value)} /></Field>
          <Field label="Taxpayer identification number"><Input maxLength={50} value={form.tin} onChange={(e) => setField("tin", e.target.value)} /></Field>
          <Field label="Overtime classification" hint="Select the employee's applicable legal arrangement. No overtime is paid until a rule is configured.">
            <select className={HR_CONTROL_CLASS} value={form.overtimePolicy} onChange={(e) => setField("overtimePolicy", e.target.value as EmployeeForm["overtimePolicy"])}>
              <option value="none">Not configured</option>
              <option value="shop_office">Shop & Office (1.5×)</option>
              <option value="custom">Custom validated rule</option>
            </select>
          </Field>
          {form.overtimePolicy === "custom" ? <>
            <Field label="Custom overtime multiplier"><Input type="number" min="0.1" max="5" step="0.01" value={form.overtimeMultiplier} onChange={(e) => setField("overtimeMultiplier", e.target.value)} /></Field>
            <Field label="Monthly hourly divisor"><Input type="number" min="1" max="2400" step="1" value={form.overtimeDivisorHours} onChange={(e) => setField("overtimeDivisorHours", e.target.value)} /></Field>
          </> : null}
          {editingId ? <Field label="Employment status">
            <select className={HR_CONTROL_CLASS} value={form.status} onChange={(e) => setField("status", e.target.value as EmployeeForm["status"])}>
              <option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </Field> : null}
          {!editingId ? <Field label="Starting salary package" hint="Optional. If selected, the package will be assigned from the employee's joined date.">
            <select className={HR_CONTROL_CLASS} value={initialPackageId} onChange={(e) => setInitialPackageId(e.target.value)}>
              <option value="">Create employee without a package</option>
              {(packages.data ?? []).filter((pkg) => pkg.active).map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.code} · {pkg.name} · LKR {centsToLkr(pkg.basePayCents)} / {pkg.payBasis}</option>)}
            </select>
          </Field> : null}
          <label className="flex items-center gap-2 self-center text-[13px]">
            <input type="checkbox" aria-label="Primary employment for APIT" checked={form.primaryEmployment} onChange={(e) => setField("primaryEmployment", e.target.checked)} />
            Primary employment for APIT
          </label>
          <Field label="Address" className="md:col-span-2 xl:col-span-3"><Textarea value={form.address} onChange={(e) => setField("address", e.target.value)} maxLength={500} /></Field>
          {!editingId && initialPackage ? <div className="rounded-md border border-brand/25 bg-brand/5 p-3 text-[12px] md:col-span-2 xl:col-span-3"><p className="font-semibold">{initialPackage.code} · {initialPackage.name}</p><p className="mt-1 text-muted-foreground">Base: LKR {centsToLkr(initialPackage.basePayCents)} per {initialPackage.payBasis} · {initialPackage.items.length} recurring component(s). The full breakdown will appear in the employee's Salary record.</p></div> : null}
          <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-3">
            <Button type="submit" pending={busy}>{editingId ? "Save employee" : "Create employee"}</Button>
            {!editingId && !(packages.data ?? []).some((pkg) => pkg.active) ? <a className="self-center text-[12px] font-medium text-brand underline" href="/hr/packages">Create a salary package first</a> : null}
            {editingId ? <Button type="button" variant="outline" onClick={() => { setEditingId(null); setForm(emptyForm()); setInitialPackageId(""); }}>Cancel edit</Button> : null}
          </div>
        </form>
      </Card>

      <Card title="Employee register" description="Only HR and administrators can read or change employee records.">
        <div className="mb-4 flex flex-wrap gap-3">
          <Input className="max-w-sm" placeholder="Search code, name, department" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={HR_CONTROL_CLASS + " max-w-[180px]"} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Code</th><th className="p-2">Employee</th><th className="p-2">Branch</th><th className="p-2">Department / title</th><th className="p-2">EPF</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead>
            <tbody>
              {(employees.data ?? []).map((employee) => (
                <tr key={employee.id} className="border-b border-border/60 hover:bg-muted/40">
                  <td className="p-2 font-mono">{employee.employeeCode}</td>
                  <td className="p-2 font-medium">{employee.fullName}</td>
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

      {selectedEmployeeId ? (() => {
        const selected = employees.data?.find((employee) => employee.id === selectedEmployeeId);
        if (!selected) return null;
        return <EmployeeDetails key={`${selected.id}-${detailSection}`} employee={selected} branchName={(branches.data ?? []).find((branch) => branch.id === selected.branchId)?.name ?? selected.branchId} packages={packages.data ?? []} initialSection={detailSection} onClose={() => setSelectedEmployeeId(null)} />;
      })() : null}
    </Page>
  );
}
