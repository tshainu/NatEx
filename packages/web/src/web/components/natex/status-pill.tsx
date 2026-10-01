import { cn } from "@/lib/utils";
import { humanise } from "@/lib/format";
import { statusColour, statusGroup, type StatusGroup } from "@/lib/status";

/**
 * StatusPill — design.md: 11px uppercase, 999px radius, 1px border in the
 * status colour at 40% with a 12% fill. "Never a bare coloured dot; the word
 * must be readable."
 *
 * The colour comes from lib/status.ts and nowhere else.
 */
export function StatusPill({
  status,
  className,
  size = "default",
}: {
  status: string;
  className?: string;
  size?: "default" | "sm" | "lg";
}) {
  const colour = statusColour(status);
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border font-semibold uppercase tracking-[0.08em]",
        size === "sm" && "px-1.5 py-[1px] text-[10px]",
        size === "default" && "px-2 py-[2px] text-[11px]",
        size === "lg" && "px-2.5 py-1 text-[12px]",
        className,
      )}
      style={{
        color: colour,
        borderColor: `color-mix(in srgb, ${colour} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${colour} 12%, transparent)`,
      }}
      title={humanise(status)}
    >
      {humanise(status)}
    </span>
  );
}

/** The group swatch used by count tiles and legends. */
export function GroupDot({ group, className }: { group: StatusGroup; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 rounded-full", className)}
      style={{ backgroundColor: statusColour(group === "created" ? "Booked" : groupSample(group)) }}
    />
  );
}

function groupSample(group: StatusGroup): string {
  switch (group) {
    case "moving":
      return "InTransit";
    case "good":
      return "Delivered";
    case "warn":
      return "OnHold";
    case "bad":
      return "Lost";
    default:
      return "Booked";
  }
}

export { statusGroup };
