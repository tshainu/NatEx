import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise } from "@/lib/format";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote, SuccessNote } from "@/components/natex/page";
import { useAuth } from "@/components/auth-provider";
import { useTemplates, type TemplateRow } from "@/queries/admin";

/**
 * Notification template editor (§10 M5; notifications module owns notify_*).
 * Placeholders are whitelisted per message — a template may only use the
 * {{names}} the sending code supplies, so an edit can never produce a message
 * with a literal "{{cod_amount}}" in it. The preview renders every channel with
 * sample values through the same renderer the worker uses. Admin writes;
 * staff may read and preview.
 */

export default function AdminTemplates() {
  const { session } = useAuth();
  const isAdmin = session!.user.role === "admin";
  const templates = useTemplates();
  const [selected, setSelected] = React.useState<string | null>(null);
  // Lives here, not in the editor: a save bumps the version, which remounts the
  // editor with fresh server values — the confirmation must survive that.
  const [savedNote, setSavedNote] = React.useState<{ key: string; text: string } | null>(null);
  const rows = templates.data ?? [];
  const current = rows.find((t) => t.key === selected) ?? rows[0] ?? null;

  return (
    <Page
      title="Notification templates"
      description="What consignees, merchants and riders are told, per channel. Every save bumps the version; the send log records which version went out."
    >
      {templates.error ? <ErrorNote>{apiMessage(templates.error, "Templates are unavailable.")}</ErrorNote> : null}
      <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
        <Card title="Messages" bodyClassName="p-0">
          <ul className="divide-y divide-border" aria-label="Templates">
            {rows.map((t) => (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => setSelected(t.key)}
                  aria-current={current?.key === t.key ? "true" : undefined}
                  className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${current?.key === t.key ? "bg-muted/60" : ""}`}
                >
                  <span className="flex w-full items-center gap-2 text-[13px] font-medium">
                    <span className="truncate">{t.name}</span>
                    {!t.active ? <Badge variant="warn">Off</Badge> : null}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {t.key} · {humanise(t.audience)} · v{t.version}
                  </span>
                </button>
              </li>
            ))}
            {templates.isLoading ? <li className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</li> : null}
          </ul>
        </Card>
        {current ? <TemplateEditor
            key={`${current.key}:${current.version}`}
            template={current}
            isAdmin={isAdmin}
            saved={savedNote?.key === current.key ? savedNote.text : null}
            onSaved={(text) => setSavedNote(text ? { key: current.key, text } : null)}
          /> : null}
      </div>
    </Page>
  );
}

type Draft = Pick<TemplateRow, "bodyWhatsapp" | "bodySms" | "bodyPush" | "pushTitle" | "channelOrder" | "active">;

function TemplateEditor({
  template,
  isAdmin,
  saved,
  onSaved,
}: {
  template: TemplateRow;
  isAdmin: boolean;
  saved: string | null;
  onSaved: (text: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const initial: Draft = {
    bodyWhatsapp: template.bodyWhatsapp ?? "",
    bodySms: template.bodySms ?? "",
    bodyPush: template.bodyPush ?? "",
    pushTitle: template.pushTitle ?? "",
    channelOrder: template.channelOrder,
    active: template.active,
  };
  const [draft, setDraft] = React.useState<Draft>(initial);
  const [problem, setProblem] = React.useState<string | null>(null);
  const debounced = useDebounced(draft, 300);

  const patch: Partial<Draft> = {};
  (Object.keys(initial) as (keyof Draft)[]).forEach((k) => {
    if (draft[k] !== initial[k]) (patch as Record<string, unknown>)[k] = draft[k];
  });
  const changed = Object.keys(patch).length > 0;

  const preview = useQuery({
    ...orpc.notifications.templatePreview.queryOptions({
      input: {
        key: template.key,
        bodyWhatsapp: debounced.bodyWhatsapp ?? undefined,
        bodySms: debounced.bodySms ?? undefined,
        bodyPush: debounced.bodyPush ?? undefined,
        pushTitle: debounced.pushTitle ?? undefined,
        channelOrder: debounced.channelOrder,
      },
    }),
    placeholderData: (previous) => previous,
  });

  const save = useMutation({
    ...orpc.notifications.templateUpdate.mutationOptions(),
    onSuccess: (row) => {
      void queryClient.invalidateQueries();
      onSaved(`Saved as version ${(row as TemplateRow).version}.`);
    },
    onError: (error) => setProblem(apiMessage(error, "This template could not be saved.")),
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (saved) onSaved(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const problems = preview.data?.problems ?? [];
  const p = preview.data;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card
        title={template.name}
        description={`${template.description ?? ""} Last edited ${dateTime(template.updatedAt)}${template.updatedByName ? ` by ${template.updatedByName}` : ""}.`}
        actions={
          isAdmin ? (
            <Button
              size="sm"
              disabled={!changed || problems.length > 0}
              pending={save.isPending}
              onClick={() => {
                setProblem(null);
                save.mutate({ key: template.key, ...patch } as Parameters<typeof save.mutate>[0]);
              }}
            >
              Save template
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {saved ? <SuccessNote>{saved}</SuccessNote> : null}
          {problem ? <ErrorNote>{problem}</ErrorNote> : null}
          {problems.length ? (
            <ErrorNote>
              {problems.map((x) => (
                <span key={x} className="block">
                  {x}
                </span>
              ))}
            </ErrorNote>
          ) : null}
          <p className="text-[12px] text-muted-foreground">
            Placeholders available:{" "}
            {(p?.allowed ?? []).map((a) => (
              <code key={a} className="mr-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{`{{${a}}}`}</code>
            ))}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Channel order" hint="Tried left to right, e.g. whatsapp,sms,push.">
              <Input
                value={draft.channelOrder}
                readOnly={!isAdmin}
                onChange={(e) => set("channelOrder", e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Status">
              <Select value={draft.active ? "on" : "off"} disabled={!isAdmin} onChange={(e) => set("active", e.target.value === "on")}>
                <option value="on">Active — sent</option>
                <option value="off">Off — never sent</option>
              </Select>
            </Field>
          </div>
          <Field label="WhatsApp">
            <Textarea
              value={draft.bodyWhatsapp ?? ""}
              readOnly={!isAdmin}
              rows={4}
              onChange={(e) => set("bodyWhatsapp", e.target.value)}
            />
          </Field>
          <Field
            label="SMS"
            hint={p ? `${p.smsLength} characters with sample values · ${p.smsSegments} billed part${p.smsSegments === 1 ? "" : "s"}` : undefined}
          >
            <Textarea value={draft.bodySms ?? ""} readOnly={!isAdmin} rows={3} onChange={(e) => set("bodySms", e.target.value)} />
          </Field>
          <div className="grid grid-cols-[1fr_2fr] gap-4">
            <Field label="Push title">
              <Input value={draft.pushTitle ?? ""} readOnly={!isAdmin} onChange={(e) => set("pushTitle", e.target.value)} />
            </Field>
            <Field label="Push body">
              <Input value={draft.bodyPush ?? ""} readOnly={!isAdmin} onChange={(e) => set("bodyPush", e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Preview" description="Rendered with sample values by the same renderer the send worker uses.">
        {preview.error ? <ErrorNote>{apiMessage(preview.error, "The preview is unavailable.")}</ErrorNote> : null}
        {p ? (
          <dl className="grid gap-4 text-[13px] md:grid-cols-3" data-testid="template-preview">
            <div>
              <dt className="label-xs text-muted-foreground">WhatsApp</dt>
              <dd className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">{p.rendered.whatsapp}</dd>
            </div>
            <div>
              <dt className="label-xs text-muted-foreground">SMS</dt>
              <dd className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2" data-testid="preview-sms">
                {p.rendered.sms}
              </dd>
            </div>
            <div>
              <dt className="label-xs text-muted-foreground">Push</dt>
              <dd className="mt-1 rounded-md bg-muted/40 px-3 py-2">
                <p className="font-medium">{p.rendered.pushTitle}</p>
                <p>{p.rendered.push}</p>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-[13px] text-muted-foreground">Rendering…</p>
        )}
      </Card>
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
