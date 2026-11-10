import * as React from "react";
import { cn } from "@/lib/utils";
import { formatTextControl, shouldTitleCaseField } from "@/lib/text-case";

type CaseFormat = "none" | "title";

function Input({
  className,
  type,
  name,
  id,
  autoComplete,
  autoCapitalize,
  onChange,
  caseFormat,
  ...props
}: React.ComponentProps<"input"> & { caseFormat?: CaseFormat }) {
  const shouldFormat = shouldTitleCaseField({
    type,
    name,
    id,
    autoComplete,
    autoCapitalize,
    caseFormat,
    className,
  });
  return (
    <input
      type={type}
      name={name}
      id={id}
      autoComplete={autoComplete}
      autoCapitalize={autoCapitalize ?? (shouldFormat ? "words" : "none")}
      onChange={(event) => {
        if (shouldFormat && !((event.nativeEvent as InputEvent).isComposing ?? false)) {
          formatTextControl(event.currentTarget);
        }
        onChange?.(event);
      }}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-none transition-colors",
        "placeholder:text-muted-foreground",
        "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30 outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-status-bad aria-invalid:ring-status-bad/20",
        className,
      )}
      {...props}
    />
  );
}

/** Field wrapper: 11px uppercase label above the control, error below it. */
function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="label-xs text-muted-foreground">{label}</span>
      {children}
      {hint && !error ? (
        <span className="text-[12px] text-muted-foreground">{hint}</span>
      ) : null}
      {error ? <span className="text-[12px] text-status-warn">{error}</span> : null}
    </label>
  );
}

function Textarea({
  className,
  name,
  id,
  autoComplete,
  autoCapitalize,
  onChange,
  caseFormat,
  ...props
}: React.ComponentProps<"textarea"> & { caseFormat?: CaseFormat }) {
  const shouldFormat = shouldTitleCaseField({
    name,
    id,
    autoComplete,
    autoCapitalize,
    caseFormat,
    className,
  });
  return (
    <textarea
      name={name}
      id={id}
      autoComplete={autoComplete}
      autoCapitalize={autoCapitalize ?? (shouldFormat ? "words" : "none")}
      onChange={(event) => {
        if (shouldFormat && !((event.nativeEvent as InputEvent).isComposing ?? false)) {
          formatTextControl(event.currentTarget);
        }
        onChange?.(event);
      }}
      data-slot="textarea"
      className={cn(
        "flex min-h-[72px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm transition-colors",
        "placeholder:text-muted-foreground",
        "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30 outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Field, Textarea };
