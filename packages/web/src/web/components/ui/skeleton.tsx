import { cn } from "@/lib/utils";

/**
 * Loading placeholder. design.md forbids anything that loops or pulses in the
 * chrome, so this is a static tinted block, not a shimmer.
 */
function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("rounded-md bg-muted-foreground/15", className)}
    />
  );
}

/** Row-shaped skeletons for a DataTable that has not resolved yet. */
function SkeletonRows({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-11 items-center gap-4 px-4">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className="h-3"
              // Ragged widths read as text, not as a loading bar.
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonRows };
