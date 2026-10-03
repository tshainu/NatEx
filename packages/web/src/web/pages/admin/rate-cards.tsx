import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { date, dateTime, humanise } from "@/lib/format";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { useAuth } from "@/components/auth-provider";
import { useRateCard, useRateCards, type RateCardListRow } from "@/queries/admin";
import { VersionPanel } from "./rate-card-editor";

/**
 * Rate cards (§10 M5; merchants module owns the tables, §4).
 *
 * The ENGINE is real — versioned tariffs, weight slabs per band, volumetric
 * weight, flat and percentage surcharges, integer cents end to end. The
 * NUMBERS are not: §15 q3 (zone structure, slabs, surcharges) is unanswered,
 * so every seeded price is a labelled placeholder. COD has no separate fee
 * (answered 2026-09-30: bundled into the delivery rate).
 *
 * Lifecycle: draft → active → superseded. Only a draft is editable; publishing
 * freezes it and supersedes the previous active version. Admin writes; ops and
 * finance may read and quote.
 */

export function Q3Banner() {
  return (
    <div
      className="rounded-md border border-status-warn/50 bg-status-warn/10 px-4 py-3 text-[13px] leading-relaxed text-status-warn"
      data-testid="q3-banner"
    >
      <p className="font-semibold">PLACEHOLDER PRICES — §15 q3 is not answered.</p>
      <p className="mt-1">
        The rate-card structure (zones, weight slabs, surcharges) has not been confirmed by NatEx, so no
        tariff here is client-approved. The engine is ready; replace these numbers with the approved tariff
        before any merchant is billed from it. COD carries no separate fee — it is bundled into the delivery
        rate (answered 2026-09-30).
      </p>
    </div>
  );
}

export default function AdminRateCards() {
  const { session } = useAuth();
  const isAdmin = session!.user.role === "admin";
  const cards = useRateCards();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const effective = selected ?? cards.data?.[0]?.id ?? null;

  const columns: Column<RateCardListRow>[] = [
    { key: "code", header: "Code", width: "w-[170px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    {
      key: "name",
      header: "Name",
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{r.name}</span>
          {r.placeholder ? <Badge variant="warn">Placeholder</Badge> : null}
        </div>
      ),
    },
    {
      key: "active",
      header: "Live",
      width: "w-[80px]",
      className: "font-mono",
      cell: (r) => (r.activeVersion ? `v${r.activeVersion.version}` : <span className="text-muted-foreground">—</span>),
    },
    {
      key: "draft",
      header: "Draft",
      width: "w-[80px]",
      className: "font-mono",
      cell: (r) => (r.draftVersion ? `v${r.draftVersion.version}` : <span className="text-muted-foreground">—</span>),
    },
    {
      key: "merchants",
      header: "Merchants",
      align: "right",
      width: "w-[100px]",
      className: "font-mono",
      cell: (r) => r.merchantCount,
    },
  ];

  return (
    <Page
      title="Rate cards"
      description="Versioned tariffs. A merchant is priced on its card's live version; editing happens on a draft, and publishing freezes it."
      actions={
        isAdmin ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            New rate card
          </Button>
        ) : null
      }
    >
      <Q3Banner />
      <DataTable
        columns={columns}
        rows={cards.data ?? []}
        rowKey={(r) => r.id}
        loading={cards.isLoading}
        error={cards.error ? apiMessage(cards.error, "Rate cards are unavailable.") : null}
        onRowClick={(r) => setSelected(r.id)}
        rowClassName={(r) => (r.id === effective ? "bg-muted/60" : undefined)}
        emptyTitle="No rate card exists"
        emptyDescription="Create one to start a draft tariff."
      />
      {effective ? <RateCardDetail key={effective} id={effective} isAdmin={isAdmin} /> : null}
      {isAdmin ? (
        <CreateRateCardDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      ) : null}
    </Page>
  );
}

function RateCardDetail({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const detail = useRateCard(id);
  const [versionId, setVersionId] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const newDraft = useMutation({
    ...orpc.rateCards.newDraft.mutationOptions(),
    onSuccess: (doc) => {
      void queryClient.invalidateQueries();
      setVersionId(doc.version.id);
    },
    onError: (error) => setProblem(apiMessage(error, "A draft could not be opened.")),
  });

  if (detail.isLoading) return <p className="text-[13px] text-muted-foreground">Loading rate card…</p>;
  if (detail.error) return <ErrorNote>{apiMessage(detail.error, "This rate card is unavailable.")}</ErrorNote>;
  const data = detail.data!;
  const versions = data.versions;
  const draft = versions.find((v) => v.status === "draft");
  const active = versions.find((v) => v.status === "active");
  const shown = versions.find((v) => v.id === versionId) ?? draft ?? active ?? versions[0] ?? null;

  return (
    <div className="grid gap-5 xl:grid-cols-[320px_1fr]">
      <div className="flex flex-col gap-5">
        <Card
          title={
            <span className="flex items-center gap-2">
              <span className="font-mono">{data.card.code}</span>
              {data.card.placeholder ? <Badge variant="warn">Placeholder</Badge> : <Badge variant="good">Approved</Badge>}
            </span>
          }
          description={data.card.name}
          actions={
            isAdmin ? (
              <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
                Edit
              </Button>
            ) : null
          }
        >
          <h3 className="label-xs mb-2 text-muted-foreground">Versions</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border" aria-label="Versions">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => setVersionId(v.id)}
                  aria-current={shown?.id === v.id ? "true" : undefined}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${shown?.id === v.id ? "bg-muted/60" : ""}`}
                >
                  <span className="font-mono font-medium">v{v.version}</span>
                  <Badge variant={v.status === "active" ? "good" : v.status === "draft" ? "brand" : "muted"}>
                    {humanise(v.status)}
                  </Badge>
                  <span className="ml-auto text-muted-foreground">
                    {v.activatedAt ? date(v.activatedAt) : dateTime(v.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {isAdmin && !draft ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              pending={newDraft.isPending}
              onClick={() => {
                setProblem(null);
                newDraft.mutate({ rateCardId: id });
              }}
            >
              Open a new draft
            </Button>
          ) : null}
          {problem ? <ErrorNote className="mt-3">{problem}</ErrorNote> : null}
          <h3 className="label-xs mb-2 mt-5 text-muted-foreground">Merchants on this card ({data.merchants.length})</h3>
          <ul className="flex flex-col gap-1 text-[12px]">
            {data.merchants.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <span className="truncate">{m.name}</span>
                {m.status !== "active" ? <Badge variant="warn">{humanise(m.status)}</Badge> : null}
              </li>
            ))}
            {data.merchants.length === 0 ? <li className="text-muted-foreground">None assigned.</li> : null}
          </ul>
          <p className="mt-3 text-[12px] text-muted-foreground">Assign a card from Operations → Merchants.</p>
        </Card>
      </div>
      {shown ? (
        <VersionPanel key={shown.id} versionId={shown.id} isAdmin={isAdmin} onGone={() => setVersionId(null)} />
      ) : (
        <Card>
          <p className="text-[13px] text-muted-foreground">This card has no version.</p>
        </Card>
      )}
      {renaming ? (
        <RenameDialog
          id={id}
          name={data.card.name}
          placeholder={data.card.placeholder}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({
  id,
  name: initialName,
  placeholder: initialPlaceholder,
  onClose,
}: {
  id: string;
  name: string;
  placeholder: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(initialName);
  const [placeholder, setPlaceholder] = React.useState(initialPlaceholder);
  const [problem, setProblem] = React.useState<string | null>(null);
  const save = useMutation({
    ...orpc.rateCards.update.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => setProblem(apiMessage(error, "This rate card could not be saved.")),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit rate card"
      description="The code is permanent; it is what invoices and the audit log refer to."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length < 3 || (name.trim() === initialName && placeholder === initialPlaceholder)}
            pending={save.isPending}
            onClick={() => save.mutate({ id, name: name.trim(), placeholder })}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Status of the numbers"
          hint="Mark approved only once NatEx has signed off this tariff (§15 q3). This changes the label, not the prices."
        >
          <Select value={placeholder ? "placeholder" : "approved"} onChange={(e) => setPlaceholder(e.target.value === "placeholder")}>
            <option value="placeholder">Placeholder — not client-approved</option>
            <option value="approved">Approved by NatEx</option>
          </Select>
        </Field>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

function CreateRateCardDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const create = useMutation({
    ...orpc.rateCards.create.mutationOptions(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      setCode("");
      setName("");
      onCreated(result.card.id);
    },
    onError: (error) => setProblem(apiMessage(error, "This rate card could not be created.")),
  });
  const codeOk = /^[A-Za-z0-9-]{3,24}$/.test(code.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New rate card"
      description="Starts as a placeholder with an empty draft: two bands, no slabs, no prices. Nothing is invented for you."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!codeOk || name.trim().length < 3}
            pending={create.isPending}
            onClick={() => {
              setProblem(null);
              create.mutate({ code: code.trim().toUpperCase(), name: name.trim(), placeholder: true });
            }}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Code" hint="3–24 letters, digits or -. Permanent.">
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
