import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * WAI-ARIA tab strip: roving tabindex, ArrowLeft/ArrowRight/Home/End move and
 * select, the selection is mirrored to `?<param>=` so a reload or a shared link
 * lands on the same tab. Panels are rendered by the caller with
 * `id="panel-<id>"` / `aria-labelledby="tab-<id>"`.
 */
export function useTabParam<T extends string>(param: string, ids: readonly T[], fallback: T) {
  const [tab, setTab] = React.useState<T>(() => {
    const v = new URLSearchParams(window.location.search).get(param);
    return (ids as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
  });
  const select = (next: T) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set(param, next);
    window.history.replaceState(null, "", url);
  };
  return [tab, select] as const;
}

export function TabStrip<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: { id: T; label: string; badge?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const move = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    else return;
    e.preventDefault();
    const next = tabs[n]!.id;
    onChange(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <div role="tablist" tabIndex={-1} aria-label={label} className="flex gap-1 border-b" onKeyDown={move}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === t.id ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.badge !== undefined ? (
            <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{t.badge}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
