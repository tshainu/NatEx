import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { humanise, money } from "@/lib/format";
import { rupeesToCents } from "@/lib/csv";
import { useAuth } from "@/components/auth-provider";
import { useMerchantOptions } from "@/queries/finance";

/**
 * Pieces every finance screen shares: who may write, the merchant picker, the
 * rupee input, and one status → badge mapping so a "paid" settlement and a
 * "paid" invoice never look different on two screens.
 */

export type Tone = "brand" | "warn" | "good" | "bad" | "muted" | "outline";

const TONES: Record<string, Tone> = {
  // settlements
  draft: "muted",
  proposed: "brand",
  approved: "warn",
  paid: "good",
  rejected: "bad",
  on_hold: "bad",
  // invoices
  issued: "brand",
  part_paid: "warn",
  void: "muted",
  // deposits
  declared: "warn",
  verified: "brand",
  banked: "good",
  // holds, alerts, disputes
  open: "bad",
  cleared: "good",
  acknowledged: "warn",
  resolved: "good",
  investigating: "warn",
  withdrawn: "muted",
  // invariant runs
  ok: "good",
  breached: "bad",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={TONES[status] ?? "muted"}>{humanise(status)}</Badge>;
}

/** Finance writes are financeProc: finance and admin. Ops reads only (§5). */
export function useCanWriteMoney(): boolean {
  const { session } = useAuth();
  const role = session?.user.role;
  return role === "finance" || role === "admin";
}

export function useMerchantName(): (id: string | null | undefined) => string {
  const options = useMerchantOptions();
  return React.useCallback(
    (id) => (id ? (options.data?.find((m) => m.id === id)?.name ?? id) : "—"),
    [options.data],
  );
}

export function MerchantSelect({
  value,
  onChange,
  allLabel,
  label = "Merchant",
  codOnly = false,
}: {
  value: string;
  onChange: (id: string) => void;
  /** When given, an empty option meaning "every merchant" is offered. */
  allLabel?: string;
  label?: string;
  codOnly?: boolean;
}) {
  const options = useMerchantOptions();
  const rows = (options.data ?? []).filter((m) => !codOnly || m.codEnabled);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{options.isPending ? "Loading merchants…" : (allLabel ?? "Choose a merchant")}</option>
      {rows
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
    </Select>
  );
}

/**
 * Rupees typed, integer cents out (§9 money rule). The parse is string
 * arithmetic — "1250.5" is 125050 cents exactly — and a bad amount is reported
 * under the field rather than silently rounded.
 */
export function useRupees(initial = "") {
  const [text, setText] = React.useState(initial);
  const parsed = rupeesToCents(text);
  const cents = "cents" in parsed ? parsed.cents : null;
  const error = "error" in parsed ? parsed.error : null;
  return { text, setText, cents, error, reset: () => setText(initial) };
}

export function RupeeInput({
  value,
  onChange,
  label,
  placeholder = "0.00",
}: {
  value: string;
  onChange: (text: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <Input
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className="font-mono"
    />
  );
}

/** A labelled money figure for drawers and summary strips. */
export function Figure({
  label,
  cents,
  tone,
  hint,
}: {
  label: string;
  cents: number | null | undefined;
  tone?: "bad" | "good" | "warn";
  hint?: string;
}) {
  const colour =
    tone === "bad" ? "text-status-bad" : tone === "good" ? "text-status-good" : tone === "warn" ? "text-status-warn" : "";
  return (
    <div className="min-w-0">
      <p className="label-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-[15px] font-medium ${colour}`}>{money(cents)}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>
  );
}

/** Server notes ("tax is switched off", "2 parcels held") shown as a plain list. */
export function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 rounded-md border border-dashed px-5 py-2.5 text-[12px] text-muted-foreground">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

export const PAGE_SIZE = 25;
export const EXPORT_PAGE = 100;
