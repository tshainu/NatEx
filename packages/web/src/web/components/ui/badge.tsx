import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 label-xs whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border bg-transparent text-muted-foreground",
        brand: "border-brand/40 bg-brand/12 text-brand-ink",
        dark: "border-ink-600 bg-ink-700 text-text-lo",
        muted: "border-border bg-muted text-muted-foreground",
        good: "border-status-good/40 bg-status-good/12 text-status-good",
        warn: "border-status-warn/40 bg-status-warn/12 text-status-warn",
        bad: "border-status-bad/40 bg-status-bad/12 text-status-bad",
        /** Later-milestone marker — used wherever a stub is shown. */
        milestone: "border-status-created/40 bg-status-created/12 text-status-created",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
