import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dayLong, dayTick, moneyTick } from "@/lib/chart";
import { money } from "@/lib/format";
import { GROUP_COLOUR, GROUP_LABEL, statusGroup, type StatusGroup } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * Dashboard charts (Round 6). Thin wrappers over recharts so every chart in
 * the app shares one axis style, one tooltip and one legend, and so a series
 * colour can only come from `lib/chart.ts` (status palette).
 *
 * Axis text and grid lines use `currentColor`, so a chart inherits the
 * surrounding text colour and works unchanged on the dark ops board.
 *
 * Each chart is a <figure> with a screen-reader caption that states the
 * series totals — a chart is never the only way to read a number.
 */

export interface Series<K extends string> {
  key: K;
  label: string;
  colour: string;
}

type Row = { date: string } & Record<string, number | string>;

export function ChartLegend({ series, className }: { series: Series<string>[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]", className)}>
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm" style={{ backgroundColor: s.colour }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function TooltipCard({
  active,
  payload,
  label,
  money: isMoney,
  heading = dayLong,
}: {
  active?: boolean;
  payload?: readonly { name?: string | number; value?: unknown; color?: string; dataKey?: unknown }[];
  label?: string | number;
  money?: boolean;
  heading?: (label: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="min-w-[160px] rounded-md border border-border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{heading(String(label ?? ""))}</p>
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center gap-2">
            <span aria-hidden className="size-2 rounded-sm" style={{ backgroundColor: p.color }} />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-mono">
              {isMoney ? money(Number(p.value ?? 0)) : Number(p.value ?? 0).toLocaleString("en-LK")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function caption(rows: Row[], series: Series<string>[], isMoney: boolean): string {
  return series
    .map((s) => {
      const total = rows.reduce((n, r) => n + Number(r[s.key] ?? 0), 0);
      return `${s.label}: ${isMoney ? money(total) : total.toLocaleString("en-LK")}`;
    })
    .join("; ");
}

const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false } as const;

/** Per-day bars (grouped or stacked) — throughput and cash checkpoints. */
export function DailyBars<K extends string>({
  data,
  series,
  title,
  height = 220,
  stacked = false,
  money: isMoney = false,
  className,
}: {
  data: ({ date: string } & Record<K, number>)[];
  series: Series<K>[];
  title: string;
  height?: number;
  stacked?: boolean;
  money?: boolean;
  className?: string;
}) {
  const rows = data as unknown as Row[];
  return (
    <figure className={cn("text-muted-foreground", className)}>
      <figcaption className="sr-only">
        {title}, {rows.length} days. {caption(rows, series, isMoney)}.
      </figcaption>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={1}>
            <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
            <XAxis dataKey="date" tickFormatter={dayTick} minTickGap={16} {...AXIS} />
            <YAxis
              width={isMoney ? 64 : 32}
              allowDecimals={false}
              tickFormatter={(v: number) => (isMoney ? moneyTick(v) : String(v))}
              {...AXIS}
            />
            <Tooltip
              cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
              content={(props) => (
                <TooltipCard active={props.active} payload={props.payload} label={props.label} money={isMoney} />
              )}
            />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.colour}
                stackId={stacked ? "a" : undefined}
                radius={stacked ? (i === series.length - 1 ? [3, 3, 0, 0] : 0) : [3, 3, 0, 0]}
                maxBarSize={stacked ? 18 : 10}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend series={series} className="mt-2" />
    </figure>
  );
}

/** Per-day areas — a smoother read of a long window. */
export function DailyArea<K extends string>({
  data,
  series,
  title,
  height = 220,
  money: isMoney = false,
  className,
}: {
  data: ({ date: string } & Record<K, number>)[];
  series: Series<K>[];
  title: string;
  height?: number;
  money?: boolean;
  className?: string;
}) {
  const rows = data as unknown as Row[];
  const id = React.useId().replace(/:/g, "");
  return (
    <figure className={cn("text-muted-foreground", className)}>
      <figcaption className="sr-only">
        {title}, {rows.length} days. {caption(rows, series, isMoney)}.
      </figcaption>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.colour} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={s.colour} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
            <XAxis dataKey="date" tickFormatter={dayTick} minTickGap={16} {...AXIS} />
            <YAxis
              width={isMoney ? 64 : 32}
              allowDecimals={false}
              tickFormatter={(v: number) => (isMoney ? moneyTick(v) : String(v))}
              {...AXIS}
            />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              content={(props) => (
                <TooltipCard active={props.active} payload={props.payload} label={props.label} money={isMoney} />
              )}
            />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.colour}
                strokeWidth={2}
                fill={`url(#${id}-${s.key})`}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend series={series} className="mt-2" />
    </figure>
  );
}

const GROUP_ORDER: StatusGroup[] = ["created", "moving", "warn", "good", "bad"];

/**
 * Status mix as a donut of the five locked status groups (design.md), with the
 * total in the middle and a legend that carries the actual counts.
 */
export function StatusDonut({
  byStatus,
  title = "Status mix",
  size = 168,
  className,
}: {
  byStatus: { status: string; count: number }[];
  title?: string;
  size?: number;
  className?: string;
}) {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    colour: GROUP_COLOUR[group],
    value: byStatus.filter((r) => statusGroup(r.status) === group).reduce((n, r) => n + r.count, 0),
  }));
  const total = groups.reduce((n, g) => n + g.value, 0);
  const shown = groups.filter((g) => g.value > 0);

  return (
    <figure className={cn("flex flex-wrap items-center gap-5", className)}>
      <figcaption className="sr-only">
        {title}: {groups.map((g) => `${g.label} ${g.value}`).join(", ")}; {total} in total.
      </figcaption>
      <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={total === 0 ? [{ label: "None", value: 1, colour: "currentColor" }] : shown}
              dataKey="value"
              nameKey="label"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={shown.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {(total === 0 ? [{ colour: "#94A3B8" }] : shown).map((g, i) => (
                <Cell key={i} fill={g.colour} fillOpacity={total === 0 ? 0.25 : 1} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-[22px] font-medium leading-none">{total.toLocaleString("en-LK")}</span>
          <span className="label-xs mt-1 text-muted-foreground">parcels</span>
        </div>
      </div>
      <ul className="min-w-[150px] flex-1 space-y-1.5 text-[13px]">
        {groups.map((g) => (
          <li key={g.group} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: g.colour }} />
            <span className="text-muted-foreground">{g.label}</span>
            <span className="ml-auto font-mono">{g.value.toLocaleString("en-LK")}</span>
            <span className="w-10 text-right font-mono text-[11px] text-muted-foreground">
              {total ? `${Math.round((g.value / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Horizontal stacked bars, one row per category — branches, merchants, ageing. */
export function CategoryBars<K extends string>({
  data,
  series,
  title,
  money: isMoney = false,
  rowHeight = 30,
  labelWidth = 120,
  rowColours,
  className,
}: {
  data: ({ label: string } & Record<K, number>)[];
  series: Series<K>[];
  title: string;
  money?: boolean;
  rowHeight?: number;
  labelWidth?: number;
  /** Single-series only: one colour per row (e.g. AR buckets ageing slate → wine). */
  rowColours?: string[];
  className?: string;
}) {
  const rows = data as unknown as ({ label: string } & Record<string, number | string>)[];
  const height = Math.max(rows.length, 1) * rowHeight + 24;
  return (
    <figure className={cn("text-muted-foreground", className)}>
      <figcaption className="sr-only">
        {title}:{" "}
        {rows
          .map(
            (r) =>
              `${r.label} — ${series
                .map((s) => `${s.label} ${isMoney ? money(Number(r[s.key] ?? 0)) : Number(r[s.key] ?? 0)}`)
                .join(", ")}`,
          )
          .join("; ")}
        .
      </figcaption>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke="currentColor" strokeOpacity={0.15} />
            <XAxis
              type="number"
              allowDecimals={false}
              tickFormatter={(v: number) => (isMoney ? moneyTick(v) : String(v))}
              {...AXIS}
            />
            <YAxis type="category" dataKey="label" width={labelWidth} {...AXIS} />
            <Tooltip
              cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
              content={(props) => (
                <TooltipCard
                  active={props.active}
                  payload={props.payload}
                  label={props.label}
                  money={isMoney}
                  heading={(l) => l}
                />
              )}
            />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="a"
                fill={s.colour}
                radius={i === series.length - 1 ? [0, 3, 3, 0] : 0}
                maxBarSize={16}
                isAnimationActive={false}
              >
                {rowColours && series.length === 1
                  ? rows.map((_, r) => <Cell key={r} fill={rowColours[r] ?? s.colour} />)
                  : null}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {series.length > 1 ? <ChartLegend series={series} className="mt-2" /> : null}
    </figure>
  );
}

/**
 * One bar split into proportional segments — "where is the cash right now".
 * Plain divs rather than a chart: it is a single ratio, and divs keep the
 * labels selectable and readable without a tooltip.
 */
export function SplitBar({
  segments,
  className,
}: {
  segments: { key: string; label: string; colour: string; value: number; hint?: string }[];
  className?: string;
}) {
  const total = segments.reduce((n, s) => n + Math.max(s.value, 0), 0);
  return (
    <div className={className}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {total > 0
          ? segments.map((s) =>
              s.value > 0 ? (
                <span
                  key={s.key}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.colour }}
                />
              ) : null,
            )
          : null}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] md:grid-cols-4">
        {segments.map((s) => (
          <li key={s.key}>
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden className="size-2 rounded-sm" style={{ backgroundColor: s.colour }} />
              {s.label}
            </p>
            <p className="mt-0.5 font-mono font-medium">{money(s.value)}</p>
            {s.hint ? <p className="text-[11px] text-muted-foreground">{s.hint}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 14 / 30 / 90-day switch for a dashboard's chart window. */
export function RangeToggle({
  value,
  onChange,
  options = [14, 30, 90],
  dark = false,
}: {
  value: number;
  onChange: (days: number) => void;
  options?: number[];
  dark?: boolean;
}) {
  return (
    <fieldset
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border p-0.5",
        dark ? "border-ink-600 bg-ink-800" : "border-border bg-card",
      )}
    >
      <legend className="sr-only">Chart window</legend>
      {options.map((days) => (
        <button
          key={days}
          type="button"
          aria-pressed={value === days}
          onClick={() => onChange(days)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-[12px] transition-colors duration-120 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40",
            value === days
              ? "bg-primary font-semibold text-primary-foreground"
              : dark
                ? "text-text-lo hover:text-text-hi"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          {days}d
        </button>
      ))}
    </fieldset>
  );
}
