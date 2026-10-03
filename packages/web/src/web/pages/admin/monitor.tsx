import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise, since } from "@/lib/format";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { useInvariantRuns, useJobsPage, useMonitorHealth, type JobFilter, type JobRow } from "@/queries/admin";

/**
 * Job monitor (§10 M5 "Monitoring"). Admin only.
 *
 * KNOWN DEVIATION (README): §4 names BullMQ; this build runs an in-process
 * outbox worker and an in-process nightly tick, so this page reads the outbox
 * table, the worker heartbeat and the invariant-run history instead of a
 * BullMQ dashboard. External uptime (Uptime Kuma) and error tracking (Sentry)
 * are configured outside the app — see RUNBOOK.md.
 */

const PAGE_SIZE = 50;
const STATES = ["pending", "processing", "done", "failed"] as const;
type JobState = (typeof STATES)[number];

const TAB_IDS = ["health", "jobs", "invariants"] as const;
const TABS: { id: (typeof TAB_IDS)[number]; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "jobs", label: "Jobs" },
  { id: "invariants", label: "Nightly invariants" },
];

function stateBadge(state: string) {
  const variant = state === "failed" ? "bad" : state === "done" ? "good" : state === "processing" ? "brand" : "muted";
  return <Badge variant={variant}>{state}</Badge>;
}

export default function AdminMonitor() {
  const [tab, setTab] = useTabParam("tab", TAB_IDS, "health");
  return (
    <Page title="System monitor" description="Background worker, queued jobs and the nightly COD invariant check.">
      <TabStrip label="Monitor sections" tabs={TABS} value={tab} onChange={setTab} />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "health" ? <HealthTab /> : tab === "jobs" ? <JobsTab /> : <InvariantsTab />}
      </div>
    </Page>
  );
}

function HealthTab() {
  const health = useMonitorHealth();
  const h = health.data;
  if (health.error) return <ErrorNote>{apiMessage(health.error, "Health is unavailable.")}</ErrorNote>;
  if (!h) return <p className="text-[13px] text-muted-foreground">Checking…</p>;
  const workerStale = h.worker.lastTickAt ? Date.now() - new Date(h.worker.lastTickAt).getTime() > h.worker.pollMs * 6 : true;
  const lastRun = h.lastInvariantRuns[0];

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="monitor-health">
      <Card title="Server">
        <KeyValueGrid>
          <KeyValue label="Database">
            <Badge variant={h.db.ok ? "good" : "bad"}>{h.db.ok ? "Reachable" : "Down"}</Badge>{" "}
            <span className="font-mono text-[12px]">{h.db.latencyMs} ms</span>
          </KeyValue>
          <KeyValue label="Up for">{formatUptime(h.uptimeSeconds)}</KeyValue>
          <KeyValue label="Server time">{dateTime(h.now)}</KeyValue>
        </KeyValueGrid>
      </Card>
      <Card title="Outbox worker" description="Delivers notifications and other side effects after each write commits.">
        <KeyValueGrid>
          <KeyValue label="State">
            <Badge variant={!h.worker.running ? "bad" : workerStale ? "warn" : "good"} data-testid="worker-state">
              {!h.worker.running ? "Stopped" : workerStale ? "Stalled" : "Running"}
            </Badge>
          </KeyValue>
          <KeyValue label="Polls every">{Math.round(h.worker.pollMs / 1000)} s</KeyValue>
          <KeyValue label="Last tick">{h.worker.lastTickAt ? since(h.worker.lastTickAt) : "never"}</KeyValue>
          <KeyValue label="Last success">{h.worker.lastOkAt ? since(h.worker.lastOkAt) : "never"}</KeyValue>
          {h.worker.lastError ? (
            <KeyValue label="Last error" className="col-span-2">
              <span className="font-mono text-[12px] text-destructive">{h.worker.lastError}</span>
            </KeyValue>
          ) : null}
        </KeyValueGrid>
      </Card>
      <Card title="Queue">
        <div className="flex flex-wrap gap-6">
          {STATES.map((s) => (
            <div key={s}>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{s}</p>
              <p
                className={`font-mono text-[22px] font-semibold ${s === "failed" && (h.outbox.totals[s] ?? 0) > 0 ? "text-destructive" : ""}`}
                data-testid={`queue-${s}`}
              >
                {h.outbox.totals[s] ?? 0}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-muted-foreground">
          {h.outbox.oldestPending
            ? `Oldest waiting job: ${h.outbox.oldestPending.topic}, queued ${since(h.outbox.oldestPending.createdAt)}.`
            : "Nothing is waiting."}
        </p>
      </Card>
      <Card title="Nightly COD invariant" description="Asserts every rider's cash and the ledger balance to zero (§8).">
        <KeyValueGrid>
          <KeyValue label="Scheduler">
            <Badge variant={h.nightly.running ? "good" : "bad"}>{h.nightly.running ? "Running" : "Stopped"}</Badge>
          </KeyValue>
          <KeyValue label="Runs at">
            {String(h.nightly.runHour).padStart(2, "0")}:00 {h.nightly.timezone}
          </KeyValue>
          <KeyValue label="Last run">
            {lastRun ? (
              <>
                <Badge variant={lastRun.result === "ok" ? "good" : "bad"}>{lastRun.result}</Badge> {lastRun.runDate}
              </>
            ) : (
              "none yet"
            )}
          </KeyValue>
          <KeyValue label="Breaches (7 runs)">{h.lastInvariantRuns.reduce((n, r) => n + r.breachCount, 0)}</KeyValue>
        </KeyValueGrid>
      </Card>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`;
}

function JobsTab() {
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<"" | JobState>("failed");
  const [topic, setTopic] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [target, setTarget] = React.useState<JobRow | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setPage(1), [state, topic]);

  const filter: JobFilter = { state: state || undefined, topic: topic.trim() || undefined };
  const jobs = useJobsPage(filter, page, PAGE_SIZE);
  const retry = useMutation({
    ...orpc.monitor.retryJob.mutationOptions(),
    onSuccess: () => {
      setTarget(null);
      setError(null);
      setNote("Job queued again. The worker picks it up on its next poll.");
      void queryClient.invalidateQueries({ queryKey: orpc.monitor.key() });
    },
    onError: (e) => {
      setTarget(null);
      setError(apiMessage(e, "The job could not be retried."));
    },
  });

  const columns: Column<JobRow>[] = [
    { key: "created", header: "Queued", width: "w-[150px]", className: "text-[12px]", cell: (r) => dateTime(r.createdAt) },
    { key: "topic", header: "Topic", width: "w-[220px]", cell: (r) => <MonoCell>{r.topic}</MonoCell> },
    { key: "state", header: "State", width: "w-[110px]", cell: (r) => stateBadge(r.state) },
    { key: "attempts", header: "Tries", width: "w-[70px]", align: "right", className: "font-mono text-[12px]", cell: (r) => r.attempts },
    { key: "error", header: "Last error", cell: (r) => <span className="line-clamp-2 font-mono text-[11.5px] text-muted-foreground">{r.lastError ?? "—"}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[100px]",
      cell: (r) =>
        r.state === "failed" ? (
          <Button size="sm" variant="outline" onClick={() => setTarget(r)} aria-label={`Retry job ${r.id}`}>
            <RefreshCw aria-hidden />
            Retry
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <DataTable
        columns={columns}
        rows={jobs.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={jobs.isPending}
        error={jobs.isError ? "Jobs could not be loaded." : null}
        emptyTitle={state === "failed" ? "No failed jobs" : "No jobs match"}
        emptyDescription={state === "failed" ? "Every side effect has been delivered or is still queued." : undefined}
        dense
        pagination={{ page, pageSize: PAGE_SIZE, total: jobs.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="State" className="w-[150px]">
              <Select value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Job state">
                <option value="">Any</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {humanise(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Topic" className="w-[220px]">
              <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Exact topic" aria-label="Job topic" />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setState("failed");
                setTopic("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Retry this job?"
        objectName={target ? `${target.topic} (${target.id})` : ""}
        body="It goes back in the queue with its attempt count kept, so if it fails again it returns straight to failed."
        confirmLabel="Retry job"
        destructive={false}
        pending={retry.isPending}
        onConfirm={() => target && retry.mutate({ id: target.id })}
      />
    </div>
  );
}

function InvariantsTab() {
  const runs = useInvariantRuns();
  type Run = NonNullable<typeof runs.data>[number];
  const columns: Column<Run>[] = [
    { key: "date", header: "Day", width: "w-[120px]", cell: (r) => <MonoCell>{r.runDate}</MonoCell> },
    { key: "result", header: "Result", width: "w-[110px]", cell: (r) => <Badge variant={r.result === "ok" ? "good" : "bad"}>{r.result}</Badge> },
    { key: "trigger", header: "Trigger", width: "w-[110px]", cell: (r) => humanise(r.trigger) },
    { key: "riders", header: "Riders", width: "w-[90px]", align: "right", className: "font-mono text-[12px]", cell: (r) => r.ridersChecked },
    { key: "breaches", header: "Breaches", width: "w-[90px]", align: "right", className: "font-mono text-[12px]", cell: (r) => r.breachCount },
    { key: "ran", header: "Ran", className: "text-[12px]", cell: (r) => dateTime(r.ranAt) },
  ];
  return (
    <DataTable
      columns={columns}
      rows={runs.data ?? []}
      rowKey={(r) => r.id}
      loading={runs.isPending}
      error={runs.isError ? "Invariant runs could not be loaded." : null}
      emptyTitle="No runs yet"
      emptyDescription="The first scheduled run happens at the configured hour, Asia/Colombo."
      rowClassName={(r) => (r.result === "ok" ? undefined : "bg-destructive/5")}
      dense
    />
  );
}
