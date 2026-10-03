import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Page, Card, ErrorNote, SuccessNote } from "@/components/natex/page";
import { useAuth } from "@/components/auth-provider";
import { useSettings, type SettingRow } from "@/queries/admin";

/**
 * SLA, business-rule and session-policy configuration (§10 M5). Every value is
 * bounded on the server (settingProblem) and every change carries a reason that
 * lands on the row and in the audit log. Money rules (COD float limit, payout
 * fee, tax switches) live with finance under COD controls, so each number has
 * exactly one home.
 */

const GROUPS: { id: SettingRow["group"]; title: string; description: string }[] = [
  { id: "sla", title: "Service levels", description: "The clocks ops works to. Changes apply to timers started after the save." },
  { id: "business", title: "Business rules", description: "Booking and field-device behaviour." },
  {
    id: "session",
    title: "Session policy",
    description: "Portal sign-in rules (§2). Changes apply at each session's next refresh.",
  },
];

function display(row: SettingRow): string {
  if (row.unit === "boolean") return row.value ? "On" : "Off";
  if (row.unit === "count") return String(row.value);
  return `${row.value} ${row.unit}`;
}

export default function AdminSettings() {
  const { session } = useAuth();
  const isAdmin = session!.user.role === "admin";
  const settings = useSettings();
  const [editing, setEditing] = React.useState<SettingRow | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  return (
    <Page
      title="Settings"
      description={
        isAdmin
          ? "SLA, business-rule and session-policy values. Each is bounded; every change needs a reason and is audited."
          : "Read-only. Only an administrator may change these values."
      }
    >
      {saved ? <SuccessNote>{saved}</SuccessNote> : null}
      {settings.error ? <ErrorNote>{apiMessage(settings.error, "Settings are unavailable.")}</ErrorNote> : null}
      {settings.isLoading ? <p className="text-[13px] text-muted-foreground">Loading settings…</p> : null}
      {GROUPS.map((g) => {
        const rows = (settings.data ?? []).filter((r) => r.group === g.id);
        if (!rows.length) return null;
        return (
          <Card key={g.id} title={g.title} description={g.description} bodyClassName="p-0">
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.key} className="flex flex-wrap items-start gap-4 px-5 py-3.5" data-testid={`setting-${r.key}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{r.label}</p>
                    <p className="mt-0.5 max-w-2xl text-[12px] text-muted-foreground">{r.description}</p>
                    {r.updatedAt ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Changed {dateTime(r.updatedAt)}
                        {r.updatedByName ? ` by ${r.updatedByName}` : ""}
                        {r.note ? ` — “${r.note}”` : ""}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[13px] font-medium" data-testid={`setting-value-${r.key}`}>
                      {display(r)}
                    </span>
                    {r.value !== r.defaultValue ? <Badge variant="muted">default {r.unit === "boolean" ? (r.defaultValue ? "on" : "off") : r.defaultValue}</Badge> : null}
                    {isAdmin && r.editable ? (
                      <Button variant="outline" size="sm" onClick={() => setEditing(r)} aria-label={`Change ${r.label}`}>
                        Change
                      </Button>
                    ) : !r.editable ? (
                      <Badge variant="outline">Fixed by §6</Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      <Card title="Money rules" description="COD float limit, payout fee and tax switches.">
        <p className="text-[13px] text-muted-foreground">
          These are finance configuration and live in{" "}
          <Link href="/finance/cod?tab=config" className="font-medium text-brand underline-offset-2 hover:underline">
            Finance → COD ledger → Limits
          </Link>
          . VAT and SSCL arithmetic exists but is off: §15 q10 is unanswered.
        </p>
      </Card>
      {editing ? (
        <SettingDialog
          key={editing.key}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setSaved(text);
          }}
        />
      ) : null}
    </Page>
  );
}

function SettingDialog({ row, onClose, onSaved }: { row: SettingRow; onClose: () => void; onSaved: (text: string) => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = React.useState(String(row.value));
  const [reason, setReason] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const save = useMutation({
    ...orpc.settings.set.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onSaved(`${row.label} saved.`);
    },
    onError: (error) => setProblem(apiMessage(error, "This value could not be saved.")),
  });
  const n = Number(value);
  const valid = /^\d+$/.test(value.trim()) && n >= row.min && n <= row.max;
  const changed = n !== row.value;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Change ${row.label}`}
      description={row.description}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || !changed || reason.trim().length < 5}
            pending={save.isPending}
            onClick={() => {
              setProblem(null);
              save.mutate({ key: row.key as Exclude<SettingRow["key"], "max_delivery_attempts">, value: n, reason: reason.trim() });
            }}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {row.unit === "boolean" ? (
          <Field label="Value">
            <Select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="1">On</option>
              <option value="0">Off</option>
            </Select>
          </Field>
        ) : (
          <Field label={`Value (${row.unit})`} hint={`Between ${row.min} and ${row.max}. Default ${row.defaultValue}.`}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" className="font-mono" />
          </Field>
        )}
        {row.key === "mfa_enforced" && value === "0" ? (
          <p className="rounded-md border border-status-bad/40 bg-status-bad/10 px-3 py-2 text-[12px] text-status-bad">
            Turning this off lets ops, admin and finance sign in with a phone code alone. §2 requires TOTP for these roles;
            use only for an incident, and turn it back on.
          </p>
        ) : null}
        <Field label="Reason" hint="Recorded on the setting and in the audit log. At least 5 characters.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
