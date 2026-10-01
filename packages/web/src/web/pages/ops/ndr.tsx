import * as React from "react";
import { useAuth } from "@/components/auth-provider";
import { Page } from "@/components/natex/page";
import { NdrQueue, RtoQueue } from "@/components/natex/ndr-panels";
import { useNdrCounts, useRtoCounts } from "@/queries/ndr";
import { cn } from "@/lib/utils";

/**
 * /ops/ndr — the non-delivery queue and the returns register (§8, §6, §10 M3).
 *
 * Two tabs, one screen: an NDR either ends in a reattempt or turns into an
 * RTO, and the desk that chases one chases the other.
 */

type Tab = "ndr" | "rto";

export default function OpsNdr() {
  const { session } = useAuth();
  const role = session!.user.role;
  const [tab, setTab] = React.useState<Tab>(() =>
    new URLSearchParams(window.location.search).get("tab") === "rto" ? "rto" : "ndr",
  );
  const ndrCounts = useNdrCounts();
  const rtoCounts = useRtoCounts();

  const select = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    {
      id: "ndr",
      label: "Non-delivery reports",
      badge: ndrCounts.data ? ndrCounts.data.open + ndrCounts.data.instructed + ndrCounts.data.reattemptScheduled : undefined,
    },
    {
      id: "rto",
      label: "Returns (RTO)",
      badge: rtoCounts.data ? rtoCounts.data.initiated + rtoCounts.data.inTransit : undefined,
    },
  ];

  return (
    <Page
      title="NDR & returns"
      description="Every failed delivery waits here for the merchant's answer, oldest first, against its SLA clock. Answers that end in a return move to the returns tab."
    >
      <div
        role="tablist"
        tabIndex={-1}
        aria-label="NDR and returns"
        className="flex gap-1 border-b"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const next: Tab = tab === "ndr" ? "rto" : "ndr";
          select(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === t.id ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.badge !== undefined ? (
              <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "ndr" ? <NdrQueue role={role} /> : <RtoQueue role={role} />}
      </div>
    </Page>
  );
}
