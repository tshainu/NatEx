import { cn } from "@/lib/utils";
import { dateTime, humanise } from "@/lib/format";
import { statusColour } from "@/lib/status";

/**
 * Timeline — one node per parcel_event. design.md: vertical rail, `to_status`
 * in its status colour, then actor · role · device · timestamp in
 * Asia/Colombo, **oldest at the bottom**.
 *
 * "Append-only data gets an append-only visual": a node is never edited, a
 * correction arrives as a new node. So this renders exactly what the API
 * returned, newest first, and never merges or rewrites rows.
 */

export interface TimelineEvent {
  id?: string;
  fromStatus?: string | null;
  toStatus: string;
  actorName?: string | null;
  actorRole?: string | null;
  deviceId?: string | null;
  notes?: string | null;
  latE6?: number | null;
  lngE6?: number | null;
  ts: string | number | Date;
}

export function Timeline({
  events,
  className,
}: {
  events: TimelineEvent[];
  className?: string;
}) {
  if (events.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        No events recorded for this parcel yet.
      </p>
    );
  }

  // Newest at the top, oldest at the bottom (design.md).
  const ordered = [...events].sort((a, b) => stamp(b.ts) - stamp(a.ts));

  return (
    <ol className={cn("relative ml-1 space-y-0", className)}>
      {/* The rail. It stops at the last node rather than running off the end. */}
      <span
        aria-hidden
        className="absolute left-[5px] top-2 w-px bg-border"
        style={{ height: `calc(100% - ${ordered.length > 1 ? "1rem" : "100%"})` }}
      />
      {ordered.map((event, i) => {
        const colour = statusColour(event.toStatus);
        return (
          <li
            key={event.id ?? `${event.toStatus}-${stamp(event.ts)}-${i}`}
            className="relative pb-5 pl-6 last:pb-0"
          >
            <span
              aria-hidden
              className="absolute left-0 top-[5px] size-[11px] rounded-full border-2"
              style={{
                borderColor: colour,
                backgroundColor:
                  i === 0 ? colour : "color-mix(in srgb, var(--card) 100%, transparent)",
              }}
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[13px] font-semibold" style={{ color: colour }}>
                {humanise(event.toStatus)}
              </span>
              {event.fromStatus ? (
                <span className="text-[12px] text-muted-foreground">
                  from {humanise(event.fromStatus)}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {[
                event.actorName,
                event.actorRole ? humanise(event.actorRole) : null,
              ]
                .filter(Boolean)
                .join(" · ") || "System"}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {dateTime(event.ts)}
              {event.deviceId ? ` · ${event.deviceId}` : ""}
            </div>
            {event.notes ? (
              <p className="mt-1 rounded-md bg-muted px-2 py-1 text-[12px]">{event.notes}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function stamp(value: string | number | Date): number {
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}
