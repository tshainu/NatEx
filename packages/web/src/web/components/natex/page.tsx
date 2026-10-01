import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** Page padding is 24px on the 8px grid (design.md). */
export function Page({
  title,
  description,
  actions,
  children,
  className,
  bleed = false,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** A full-height page (board, table) that manages its own scrolling. */
  bleed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-5 p-6",
        bleed ? "h-full overflow-hidden" : "",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[24px] font-bold">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {bleed ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

/** Card padding is 20px (design.md). */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div>
            <h2 className="font-display text-[15px] font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Label/value pair for detail drawers and read-only panels. */
export function KeyValue({
  label,
  children,
  mono = false,
  className,
}: {
  label: string;
  children: React.ReactNode;
  /** AWB, seal, UTR, device id and money are mono, mandatorily (design.md). */
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="label-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-[13px]", mono && "font-mono font-medium")}>
        {children}
      </dd>
    </div>
  );
}

export function KeyValueGrid({
  children,
  columns = 2,
  className,
}: {
  children: React.ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-4 gap-y-3.5",
        columns === 1 && "grid-cols-1",
        columns === 2 && "grid-cols-2",
        columns === 3 && "grid-cols-3",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * A screen that belongs to a later milestone. M1 ships the whole navigation so
 * the shape of the product is legible, and says plainly what is not built yet
 * rather than dead-ending on a blank page.
 */
export function MilestoneStub({
  title,
  milestone,
  what,
  detail,
}: {
  title: string;
  milestone: number;
  what: string;
  detail?: string;
}) {
  return (
    <Page title={title} actions={<Badge variant="milestone">Milestone {milestone}</Badge>}>
      <Card className="max-w-2xl">
        <p className="text-[14px] font-semibold">{what}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {detail ??
            `This screen is scoped to Milestone ${milestone}. Milestone 1 delivers identity, merchants, parcel booking with the full state machine, pickup collection and serviceability routing — the endpoints behind this page do not exist yet and nothing here is stubbed with fake data.`}
        </p>
      </Card>
    </Page>
  );
}

/** Inline plain-language error banner — never a raw status code (design.md). */
export function ErrorNote({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[13px] text-status-warn",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function SuccessNote({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <output
      className={cn(
        "block rounded-md border border-status-good/40 bg-status-good/10 px-3 py-2 text-[13px] text-status-good",
        className,
      )}
    >
      {children}
    </output>
  );
}
