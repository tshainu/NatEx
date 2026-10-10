import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { centsToLkr, HR_CONTROL_CLASS, lkrToCents } from "./shared";
import { HrNavigation } from "./navigation";

type ItemForm = {
  label: string;
  kind: "earning" | "deduction";
  amountLkr: string;
  epfEligible: boolean;
  etfEligible: boolean;
  apitTaxable: boolean;
  overtimeEligible: boolean;
  proration: "full_period" | "unpaid_leave_prorated";
};
type PackageForm = {
  code: string;
  name: string;
  description: string;
  payBasis: "monthly" | "daily" | "hourly";
  basePayLkr: string;
  baseEpfEligible: boolean;
  baseEtfEligible: boolean;
  baseApitTaxable: boolean;
  items: ItemForm[];
};
const emptyPackage = (): PackageForm => ({
  code: "", name: "", description: "", payBasis: "monthly", basePayLkr: "",
  baseEpfEligible: true, baseEtfEligible: true, baseApitTaxable: true, items: [],
});
const emptyItem = (): ItemForm => ({
  label: "", kind: "earning", amountLkr: "", epfEligible: false, etfEligible: false,
  apitTaxable: false, overtimeEligible: false, proration: "full_period",
});

export default function HrPackages() {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<PackageForm>(emptyPackage);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const packages = useQuery({ ...orpc.hr.salaryPackages.queryOptions() });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.hr.salaryPackages.key() });
  const create = useMutation({ ...orpc.hr.createSalaryPackage.mutationOptions(), onSuccess: (pkg) => { setNote(`${pkg.code} was created.`); setForm(emptyPackage()); refresh(); } });
  const update = useMutation({ ...orpc.hr.updateSalaryPackage.mutationOptions(), onSuccess: (pkg) => { setNote(`${pkg.code} was updated.`); setEditingId(null); setForm(emptyPackage()); refresh(); } });

  function updateForm<K extends keyof PackageForm>(key: K, value: PackageForm[K]) {
    setForm((old) => ({ ...old, [key]: value }));
  }
  function updateItem(index: number, patch: Partial<ItemForm>) {
    setForm((old) => ({ ...old, items: old.items.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  }
  function edit(pkg: NonNullable<typeof packages.data>[number]) {
    setEditingId(pkg.id);
    setForm({
      code: pkg.code, name: pkg.name, description: pkg.description ?? "", payBasis: pkg.payBasis as PackageForm["payBasis"],
      basePayLkr: centsToLkr(pkg.basePayCents), baseEpfEligible: pkg.baseEpfEligible,
      baseEtfEligible: pkg.baseEtfEligible, baseApitTaxable: pkg.baseApitTaxable,
      items: pkg.items.map((item) => ({
        label: item.label, kind: item.kind as ItemForm["kind"], amountLkr: centsToLkr(item.amountCents),
        epfEligible: item.epfEligible, etfEligible: item.etfEligible, apitTaxable: item.apitTaxable,
        overtimeEligible: item.overtimeEligible, proration: item.proration as ItemForm["proration"],
      })),
    });
    setNote(null);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setNote(null);
    const basePayCents = lkrToCents(form.basePayLkr);
    if (basePayCents === null || basePayCents <= 0) { setNote("Enter a positive base pay with no more than two decimal places."); return; }
    const items = form.items.map((item) => ({ ...item, amountCents: lkrToCents(item.amountLkr) }));
    if (items.some((item) => item.amountCents === null || item.amountCents <= 0)) { setNote("Every component needs a positive LKR amount with no more than two decimal places."); return; }
    const payload = {
      code: form.code, name: form.name, description: form.description || null, payBasis: form.payBasis,
      basePayCents, baseEpfEligible: form.baseEpfEligible, baseEtfEligible: form.baseEtfEligible,
      baseApitTaxable: form.baseApitTaxable,
      items: items.map(({ amountCents, ...item }) => ({ ...item, amountCents: amountCents! })),
    };
    if (editingId) update.mutate({ packageId: editingId, ...payload });
    else create.mutate(payload);
  }

  const error = packages.error ?? create.error ?? update.error;
  return (
    <Page title="Salary packages" description="Design reusable compensation packages. Contribution and tax-base treatment is stored per component; approved payroll keeps an immutable snapshot.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "Salary packages could not be loaded or saved.")}</ErrorNote> : null}
      <HrNavigation />
      <Card title={editingId ? "Edit salary package" : "Create salary package"} description="Create a new version rather than changing an already assigned package; historic payslips never recalculate.">
        <form className="space-y-5" onSubmit={submit}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Package code"><Input required maxLength={20} value={form.code} onChange={(e) => updateForm("code", e.target.value.toUpperCase())} /></Field>
            <Field label="Package name"><Input required value={form.name} onChange={(e) => updateForm("name", e.target.value)} /></Field>
            <Field label="Pay basis"><select className={HR_CONTROL_CLASS} value={form.payBasis} onChange={(e) => updateForm("payBasis", e.target.value as PackageForm["payBasis"])}><option value="monthly">Monthly</option><option value="daily">Daily rate</option><option value="hourly">Hourly rate</option></select></Field>
            <Field label={`Base pay (LKR per ${form.payBasis === "monthly" ? "month" : form.payBasis})`}><Input inputMode="decimal" type="number" min="0.01" step="0.01" required value={form.basePayLkr} onChange={(e) => updateForm("basePayLkr", e.target.value)} /></Field>
          </div>
          <Field label="Package description"><Textarea maxLength={500} value={form.description} onChange={(e) => updateForm("description", e.target.value)} /></Field>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
            <label className="flex items-center gap-2"><input type="checkbox" aria-label="Base enters EPF wages" checked={form.baseEpfEligible} onChange={(e) => updateForm("baseEpfEligible", e.target.checked)} /> Base enters EPF wages</label>
            <label className="flex items-center gap-2"><input type="checkbox" aria-label="Base enters ETF wages" checked={form.baseEtfEligible} onChange={(e) => updateForm("baseEtfEligible", e.target.checked)} /> Base enters ETF wages</label>
            <label className="flex items-center gap-2"><input type="checkbox" aria-label="Base enters APIT wages" checked={form.baseApitTaxable} onChange={(e) => updateForm("baseApitTaxable", e.target.checked)} /> Base enters APIT wages</label>
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-[14px] font-semibold">Recurring components</h3><p className="text-[12px] text-muted-foreground">Add allowances or deductions and mark statutory contribution/tax bases according to the component's legal treatment.</p></div><Button type="button" variant="outline" onClick={() => updateForm("items", [...form.items, emptyItem()])}>Add component</Button></div>
            {form.items.map((item, index) => <div key={`${index}-${item.label}`} className="grid gap-3 rounded-md border p-3 md:grid-cols-2 xl:grid-cols-[1.3fr_130px_150px_1fr_auto]">
              <Field label="Component name"><Input required value={item.label} onChange={(e) => updateItem(index, { label: e.target.value })} /></Field>
              <Field label="Type"><select className={HR_CONTROL_CLASS} value={item.kind} onChange={(e) => updateItem(index, { kind: e.target.value as ItemForm["kind"], ...(e.target.value === "deduction" ? { epfEligible: false, etfEligible: false, apitTaxable: false, overtimeEligible: false } : {}) })}><option value="earning">Earning</option><option value="deduction">Deduction</option></select></Field>
              <Field label="Amount (LKR)"><Input type="number" min="0.01" step="0.01" required value={item.amountLkr} onChange={(e) => updateItem(index, { amountLkr: e.target.value })} /></Field>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <label className="flex items-center gap-1"><input type="checkbox" aria-label={`${item.label || "Component"} enters EPF wages`} checked={item.epfEligible} disabled={item.kind === "deduction"} onChange={(e) => updateItem(index, { epfEligible: e.target.checked })} /> EPF</label>
                <label className="flex items-center gap-1"><input type="checkbox" aria-label={`${item.label || "Component"} enters ETF wages`} checked={item.etfEligible} disabled={item.kind === "deduction"} onChange={(e) => updateItem(index, { etfEligible: e.target.checked })} /> ETF</label>
                <label className="flex items-center gap-1"><input type="checkbox" aria-label={`${item.label || "Component"} enters APIT wages`} checked={item.apitTaxable} disabled={item.kind === "deduction"} onChange={(e) => updateItem(index, { apitTaxable: e.target.checked })} /> APIT</label>
                <label className="flex items-center gap-1"><input type="checkbox" aria-label={`${item.label || "Component"} enters the overtime rate`} checked={item.overtimeEligible} disabled={item.kind === "deduction"} onChange={(e) => updateItem(index, { overtimeEligible: e.target.checked })} /> OT rate</label>
                {item.kind === "earning" ? <select aria-label="Unpaid leave proration" className={HR_CONTROL_CLASS + " max-w-[190px]"} value={item.proration} onChange={(e) => updateItem(index, { proration: e.target.value as ItemForm["proration"] })}><option value="full_period">Full amount</option><option value="unpaid_leave_prorated">Prorate for unpaid leave</option></select> : null}
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => updateForm("items", form.items.filter((_, i) => i !== index))}>Remove</Button>
            </div>)}
          </div>
          <div className="flex gap-2"><Button type="submit" pending={create.isPending || update.isPending}>{editingId ? "Save package" : "Create package"}</Button>{editingId ? <Button type="button" variant="outline" onClick={() => { setEditingId(null); setForm(emptyPackage()); }}>Cancel edit</Button> : null}</div>
        </form>
      </Card>

      <Card title="Package catalogue">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]">
          <thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Code</th><th className="p-2">Package</th><th className="p-2">Basis</th><th className="p-2 text-right">Base pay</th><th className="p-2">Components</th><th className="p-2">Status</th><th className="p-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{(packages.data ?? []).map((pkg) => <tr key={pkg.id} className="border-b border-border/60"><td className="p-2 font-mono">{pkg.code}</td><td className="p-2 font-medium">{pkg.name}<span className="block text-[11px] text-muted-foreground">{pkg.description}</span></td><td className="p-2">{pkg.payBasis}</td><td className="p-2 text-right font-mono">LKR {centsToLkr(pkg.basePayCents)}</td><td className="p-2">{pkg.items.length} components</td><td className="p-2"><Badge variant={pkg.active ? "good" : "outline"}>{pkg.active ? "active" : "inactive"}</Badge></td><td className="p-2"><Button size="sm" variant="outline" onClick={() => edit(pkg)}>Edit</Button></td></tr>)}</tbody>
        </table>{(packages.data?.length ?? 0) === 0 && !packages.isPending ? <p className="py-7 text-center text-[13px] text-muted-foreground">No salary packages have been created.</p> : null}</div>
      </Card>
    </Page>
  );
}
