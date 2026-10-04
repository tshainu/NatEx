import * as React from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PackageSearch, Search, ShieldCheck } from "lucide-react";
import { orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { statusColour } from "@/lib/status";
import { date, dateTime, since } from "@/lib/format";

/**
 * Public tracking, §10 M2: `/track/:awb`. Unauthenticated, so it is also the
 * one screen a stranger can reach — which makes PDPA No. 9 of 2022 (§9) the
 * constraint that shapes it.
 *
 * The server decides what is public (`parcels.publicTracking`): a coarse
 * status label, the destination *locality* only, and timestamps. No consignee
 * name, no phone, no street address, no COD amount, no merchant identity. This
 * page renders that payload and asks for nothing more — the restraint lives on
 * the server, and this screen must not reintroduce a richer authenticated call.
 */

interface TrackingStep {
  status: string;
  label: string;
  ts: string | number | Date;
}

interface Tracking {
  awb: string;
  status: string;
  publicStatus: string;
  destinationArea: string | null;
  attempts: number;
  bookedAt: string | number | Date;
  lastUpdatedAt: string | number | Date;
  timeline: TrackingStep[];
}

export default function Track() {
  const params = useParams<{ awb?: string }>();
  const [, navigate] = useLocation();
  const awb = (params.awb ?? "").trim().toUpperCase();
  const [draft, setDraft] = React.useState(awb);

  React.useEffect(() => {
    setDraft(awb);
  }, [awb]);

  const query = useQuery({
    ...orpc.parcels.track.queryOptions({ input: { awb } }),
    enabled: awb.length >= 3,
    retry: false,
  });

  const data = query.data as Tracking | undefined;
  const notFound = query.isError;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="flex items-center gap-2 outline-none">
            <span className="grid size-7 place-items-center rounded-md bg-brand font-display text-[13px] font-bold text-primary-foreground">
              N
            </span>
            <span className="font-display text-[16px] font-bold tracking-tight">NatEx</span>
          </Link>
          <span className="text-[12px] text-muted-foreground">Track a shipment</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-[28px] font-bold leading-tight tracking-tight">
          Where is my parcel?
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
          Enter the tracking number from your confirmation message.
        </p>

        <form
          className="mt-5 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft.trim().toUpperCase();
            if (next.length >= 3) navigate(`/track/${encodeURIComponent(next)}`);
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="NX2026…"
            aria-label="Tracking number"
            className="font-mono sm:flex-1"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={draft.trim().length < 3}>
            <Search className="size-4" />
            Track
          </Button>
        </form>

        {awb.length < 3 ? (
          <EmptyPrompt />
        ) : query.isPending ? (
          <p className="mt-8 text-[14px] text-muted-foreground">Looking up {awb}…</p>
        ) : notFound || !data ? (
          <NotFoundCard awb={awb} />
        ) : (
          <Result tracking={data} />
        )}

        <PrivacyNote />
      </main>
    </div>
  );
}

function EmptyPrompt() {
  return (
    <div className="mt-8 rounded-lg border border-dashed p-8 text-center">
      <PackageSearch className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-2 text-[14px] text-muted-foreground">
        Your tracking number starts with <span className="font-mono">NX</span> and is on the SMS the
        sender's despatch team sent you.
      </p>
    </div>
  );
}

function NotFoundCard({ awb }: { awb: string }) {
  return (
    <div className="mt-8 rounded-lg border bg-card p-6">
      <h2 className="text-[15px] font-semibold">No shipment matches {awb}</h2>
      <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
        Check the number for a transposed digit. A parcel also will not appear here until the sender
        has handed it to NatEx — if it was booked in the last few minutes, try again shortly.
      </p>
    </div>
  );
}

function Result({ tracking }: { tracking: Tracking }) {
  // Newest first, matching the authenticated custody timeline.
  const steps = [...tracking.timeline].sort((a, b) => stamp(b.ts) - stamp(a.ts));
  const colour = statusColour(tracking.status);

  return (
    <section className="mt-8 space-y-4">
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="relative p-5">
          <span
            aria-hidden
            className="absolute left-0 top-0 h-full w-[3px]"
            style={{ backgroundColor: colour }}
          />
          <p className="label-xs text-muted-foreground">Tracking number</p>
          <p className="font-mono text-[18px] font-medium tracking-tight">{tracking.awb}</p>

          <p className="mt-4 text-[20px] font-semibold leading-snug" style={{ color: colour }}>
            {tracking.publicStatus}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Updated {since(tracking.lastUpdatedAt)} · {dateTime(tracking.lastUpdatedAt)}
          </p>

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3">
            <div>
              <dt className="label-xs text-muted-foreground">Destination</dt>
              <dd className="mt-0.5 text-[14px]">{tracking.destinationArea ?? "Sri Lanka"}</dd>
            </div>
            <div>
              <dt className="label-xs text-muted-foreground">Booked</dt>
              <dd className="mt-0.5 text-[14px]">{date(tracking.bookedAt)}</dd>
            </div>
            <div>
              <dt className="label-xs text-muted-foreground">Delivery attempts</dt>
              <dd className="mt-0.5 text-[14px]">
                {tracking.attempts === 0 ? "None yet" : tracking.attempts}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Journey so far
        </h2>
        <ol className="relative mt-4 ml-1">
          <span
            aria-hidden
            className="absolute left-[5px] top-2 w-px bg-border"
            style={{ height: `calc(100% - ${steps.length > 1 ? "1rem" : "100%"})` }}
          />
          {steps.map((step, index) => {
            const stepColour = statusColour(step.status);
            return (
              <li key={`${step.status}-${stamp(step.ts)}-${index}`} className="relative pb-5 pl-6 last:pb-0">
                <span
                  aria-hidden
                  className="absolute left-0 top-[5px] size-[11px] rounded-full border-2"
                  style={{
                    borderColor: stepColour,
                    backgroundColor: index === 0 ? stepColour : "transparent",
                  }}
                />
                <p className="text-[14px] font-medium leading-snug">{step.label}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{dateTime(step.ts)}</p>
              </li>
            );
          })}
        </ol>
        {steps.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">
            Booked, and waiting for its first scan.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PrivacyNote() {
  return (
    <footer className="mt-10 border-t pt-5">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-[13px] font-medium">This page shows deliberately little</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Anyone with a tracking number can open it, so under Sri Lanka's Personal Data
            Protection Act No. 9 of 2022 it carries no recipient name, phone number or street
            address, and no payment amount — only the shipment's progress and the town it is
            heading to. Staff and the sender see the full record after signing in.
          </p>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            NatEx staff:{" "}
            <Link href="/login" className="font-medium text-brand underline-offset-2 hover:underline">
              sign in
            </Link>
            .
          </p>
        </div>
      </div>
      <Badge variant="muted" className="mt-4">
        Times shown in Asia/Colombo
      </Badge>
    </footer>
  );
}

function stamp(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
