import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Native select, retinted. Chosen over a Radix listbox on purpose: these are
 * dense operational forms and a native control keeps keyboard reachability
 * (design.md: "every action keyboard reachable") without extra focus plumbing.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="select"
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-input bg-card pl-3 pr-8 text-sm transition-colors",
          "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30 outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}

export { Select };
