import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { client, orpc } from "@/lib/api";
import { colomboToday, dateTime, humanise } from "@/lib/format";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Page, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { colomboDayStartIso, useAuditEntities, useAuditPage, type AuditFilter, type AuditRow } from "@/queries/admin";

/**
 * Audit viewer (§10 M5, §5 "audit log: append-only"). Read only — the log has
 * no edit or delete path anywhere in the system. Rows are shown as stored,
 * which means already redacted (bank account numbers masked, OTPs and
 * secrets dropped) by shared/redact.ts at write time.
 */

const PAGE_SIZE = 50;
const EXPORT_PAGE = 200;

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function pretty(json: string | null): string {
  if (!json) return "—";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export default function AdminAudit() {
  const entities = useAuditEntities();
  const users = useQuery({ ...orpc.identity.listUsers.queryOptions(), staleTime: 60_000 });
  const [entity, setEntity] = React.useState("");
  const [entityId, setEntityId] = React.useState("");
  const [action, setAction] = React.useState("");
  const [actorId, setActorId] = React.useState("");
  const [fromDay, setFromDay] = React.useState("");
  const [toDay, setToDay] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  React.useEffect(() => setPage(1), [entity, entityId, action, actorId, fromDay, toDay]);

  const actorName = React.useMemo(() => {
    const map = new Map((users.data ?? []).map((u) => [u.id, u.name] as const));
    return (id: string | null) => (id ? (map.get(id) ?? id) : "System");
  }, [users.data]);

  const rangeBad = Boolean(fromDay && toDay && toDay < fromDay);
  const filter: AuditFilter = {
    entity: entity || undefined,
    entityId: entityId.trim() || undefined,
    action: action.trim() || undefined,
    actorId: actorId || undefined,
    from: fromDay ? colomboDayStartIso(fromDay) : undefined,
    to: toDay && !rangeBad ? colomboDayStartIso(nextDay(toDay)) : undefined,
  };
  const list = useAuditPage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];
  const opened = rows.find((r) => r.id === openId) ?? null;

  const columns: Column<AuditRow>[] = [
    { key: "ts", header: "When", width: "w-[160px]", className: "text-[12px]", cell: (r) => dateTime(r.ts) },
    { key: "action", header: "Action", width: "w-[220px]", cell: (r) => <MonoCell>{r.action}</MonoCell> },
    { key: "entity", header: "Entity", width: "w-[170px]", cell: (r) => <span className="text-[12px]">{r.entity}</span> },
    { key: "entityId", header: "Entity id", cell: (r) => <MonoCell>{r.entityId}</MonoCell> },
    {
      key: "actor",
      header: "Actor",
      width: "w-[200px]",
      cell: (r) => (
        <span className="line-clamp-1 text-[12px]">
          {actorName(r.actorId)}
          {r.actorRole ? <span className="text-muted-foreground"> · {r.actorRole}</span> : null}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Audit log"
      description="Every write in the system, newest first. Append-only: nothing here can be edited or deleted. Sensitive values were redacted when written."
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "The audit log could not be loaded." : null}
        emptyTitle="No audit entries match"
        emptyDescription="Widen the date range or clear a filter."
        onRowClick={(r) => setOpenId(r.id)}
        dense
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Entity" className="w-[190px]">
              <Select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Audit entity">
                <option value="">Any entity</option>
                {(entities.data ?? []).map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Entity id" className="w-[170px]">
              <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="Exact id" aria-label="Entity id" />
            </Field>
            <Field label="Action starts with" className="w-[170px]">
              <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. rate_card." aria-label="Action prefix" />
            </Field>
            <Field label="Actor" className="w-[190px]">
              <Select value={actorId} onChange={(e) => setActorId(e.target.value)} aria-label="Audit actor">
                <option value="">Anyone</option>
                {(users.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({humanise(u.role)})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From (Colombo)" className="w-[150px]">
              <Input type="date" value={fromDay} max={colomboToday()} onChange={(e) => setFromDay(e.target.value)} aria-label="From date" />
            </Field>
            <Field label="To (Colombo)" className="w-[150px]" error={rangeBad ? "Before the start date" : undefined}>
              <Input type="date" value={toDay} max={colomboToday()} onChange={(e) => setToDay(e.target.value)} aria-label="To date" />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEntity("");
                setEntityId("");
                setAction("");
                setActorId("");
                setFromDay("");
                setToDay("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto">
              <ExportCsvButton<AuditRow>
                filename={`natex-audit-${colomboToday()}.csv`}
                header={["id", "ts", "entity", "entity_id", "action", "actor_id", "actor_role", "branch_id", "device_id", "request_id", "before_json", "after_json"]}
                toRow={(r) => [
                  r.id,
                  dateTime(r.ts),
                  r.entity,
                  r.entityId,
                  r.action,
                  r.actorId ?? "",
                  r.actorRole ?? "",
                  r.branchId ?? "",
                  r.deviceId ?? "",
                  r.requestId ?? "",
                  r.beforeJson ?? "",
                  r.afterJson ?? "",
                ]}
                fetchPage={async (p) => {
                  const out = await client.audit.list({ ...filter, limit: EXPORT_PAGE, offset: (p - 1) * EXPORT_PAGE });
                  return { rows: out.rows, total: out.total, pageSize: EXPORT_PAGE };
                }}
              />
            </div>
          </>
        }
      />
      <Drawer
        open={Boolean(opened)}
        onOpenChange={(o) => !o && setOpenId(null)}
        title={opened ? <span className="font-mono text-[14px]">{opened.action}</span> : ""}
        subtitle={opened ? dateTime(opened.ts) : undefined}
        className="w-[640px]"
      >
        {opened ? (
          <div className="space-y-5" data-testid="audit-detail">
            <KeyValueGrid>
              <KeyValue label="Entity">{opened.entity}</KeyValue>
              <KeyValue label="Entity id">
                <span className="font-mono text-[12px]">{opened.entityId}</span>
              </KeyValue>
              <KeyValue label="Actor">{actorName(opened.actorId)}</KeyValue>
              <KeyValue label="Role">{opened.actorRole ? <Badge variant="outline">{opened.actorRole}</Badge> : "—"}</KeyValue>
              <KeyValue label="Branch">{opened.branchId ?? "—"}</KeyValue>
              <KeyValue label="Device">{opened.deviceId ?? "—"}</KeyValue>
              <KeyValue label="Request id">
                <span className="font-mono text-[12px]">{opened.requestId ?? "—"}</span>
              </KeyValue>
            </KeyValueGrid>
            {(["beforeJson", "afterJson"] as const).map((k) => (
              <section key={k}>
                <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {k === "beforeJson" ? "Before" : "After"}
                </h3>
                <pre
                  className="max-h-[320px] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed"
                  data-testid={`audit-${k}`}
                >
                  {pretty(opened[k])}
                </pre>
              </section>
            ))}
          </div>
        ) : null}
      </Drawer>
    </Page>
  );
}
