import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * MetricTile — design.md: "big mono number, 11px uppercase label above,
 * optional delta. Used on every portal dashboard."
 *
 * `accent` takes a status colour for the left rule only when the tile *is* a
 * status count. Decoration never borrows a status colour.
 */
export function MetricTile({
  label,
  value,
  delta,
  accent,
  hint,
  onClick,
  active = false,
  className,
}: {
  label: string;
  value: React.ReactNode;
  delta?: { value: string; direction: "up" | "down" | "flat" };
  accent?: string;
  hint?: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border bg-card px-4 py-3 text-left transition-colors duration-120",
        active ? "border-brand/60 bg-brand/8" : "border-border",
        onClick && "hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40",
        className,
      )}
    >
      {accent ? (
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-[3px]"
          style={{ backgroundColor: accent }}
        />
      ) : null}
      <p className="label-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono font-medium leading-none tracking-tight",
          // Money such as "Rs. 204,945.75" would wrap at 26px in a quarter-width tile.
          typeof value === "string" && value.length > 11 ? "whitespace-nowrap text-[18px]" : "text-[26px]",
        )}
      >
        {value}
      </p>
      {delta ? (
        <p
          className={cn(
            "mt-1.5 text-[12px] font-medium",
            delta.direction === "down" ? "text-status-warn" : "text-muted-foreground",
          )}
        >
          {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "•"}{" "}
          {delta.value}
        </p>
      ) : null}
      {hint ? <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p> : null}
    </Tag>
  );
}

/** Compact count row used in the ops board's right-hand column. */
export function CountRow({
  label,
  value,
  colour,
  active = false,
  onClick,
}: {
  label: string;
  value: number;
  colour: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-120",
        active ? "bg-brand/12" : "hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40",
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colour }}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <span className="font-mono text-[14px] font-medium">{value}</span>
    </button>
  );
}
