/* oxlint-disable jsx-a11y/prefer-tag-over-role -- This searchable popup needs a custom listbox with button options and COD labels; a native select cannot contain its search field. */
/* oxlint-disable jsx-a11y/no-redundant-roles -- An editable search input controlling a custom listbox needs an explicit combobox role (there is no native datalist). */
import * as React from "react";
import { ChevronDown } from "lucide-react";

export interface BookableMerchantOption {
  id: string;
  name: string;
  codEnabled: boolean;
  status: string;
}

/** Search only the fields returned by the merchant options endpoint. */
export function filterBookableMerchants(
  merchants: readonly BookableMerchantOption[],
  query: string,
): BookableMerchantOption[] {
  const search = query.trim().toLowerCase();
  return merchants.filter(
    (merchant) =>
      merchant.status === "active" &&
      (!search || merchant.name.toLowerCase().includes(search)),
  );
}

interface MerchantPickerProps {
  merchants: readonly BookableMerchantOption[];
  value: string;
  onChange: (merchantId: string) => void;
  loading?: boolean;
  error?: string | null;
}

export function MerchantPicker({
  merchants,
  value,
  onChange,
  loading = false,
  error = null,
}: MerchantPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listboxId = React.useId();
  const searchId = React.useId();

  const activeMerchants = React.useMemo(
    () => filterBookableMerchants(merchants, ""),
    [merchants],
  );
  const matches = React.useMemo(
    () => filterBookableMerchants(activeMerchants, query),
    [activeMerchants, query],
  );
  const selectedMerchant = activeMerchants.find((merchant) => merchant.id === value);

  const closePicker = React.useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openPicker = React.useCallback(() => {
    setQuery("");
    setActiveIndex(activeMerchants.length ? 0 : -1);
    setOpen(true);
  }, [activeMerchants.length]);

  React.useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePicker();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, closePicker]);

  const choose = (merchant: BookableMerchantOption) => {
    onChange(merchant.id);
    closePicker(true);
  };

  const moveActive = (delta: number) => {
    if (!matches.length) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((current) => {
      if (current < 0) return delta > 0 ? 0 : matches.length - 1;
      return Math.max(0, Math.min(matches.length - 1, current + delta));
    });
  };

  const activeMerchant = matches[activeIndex];

  React.useEffect(() => {
    if (open && activeMerchant) {
      document.getElementById(`${listboxId}-option-${activeMerchant.id}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeMerchant, listboxId]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closePicker();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={selectedMerchant ? `Merchant: ${selectedMerchant.name}` : "Select a merchant"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? closePicker() : openPicker())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) openPicker();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            closePicker(true);
          }
        }}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-left text-sm outline-none transition-colors focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30"
      >
        <span className={selectedMerchant ? "min-w-0 truncate" : "text-muted-foreground"}>
          {selectedMerchant ? (
            <>
              {selectedMerchant.name}
              {!selectedMerchant.codEnabled ? (
                <span className="ml-1.5 text-xs text-muted-foreground">(COD disabled)</span>
              ) : null}
            </>
          ) : (
            "Select a merchant…"
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {/* Keep native required-field validation in addition to the page's submit guard. */}
      <select
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        required
        value={selectedMerchant ? selectedMerchant.id : ""}
        onChange={() => undefined}
      >
        <option value="">Select a merchant…</option>
        {activeMerchants.map((merchant) => (
          <option key={merchant.id} value={merchant.id}>
            {merchant.name}
          </option>
        ))}
      </select>

      {open ? (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-card p-2 shadow-lg">
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            role="combobox"
            aria-label="Search merchants"
            aria-autocomplete="list"
            aria-invalid={value !== "" && !selectedMerchant ? true : undefined}
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeMerchant ? `${listboxId}-option-${activeMerchant.id}` : undefined}
            aria-required="true"
            autoComplete="off"
            placeholder="Search by merchant name"
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              const nextMatches = filterBookableMerchants(activeMerchants, nextQuery);
              setQuery(nextQuery);
              setActiveIndex(nextMatches.length ? 0 : -1);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Home" && matches.length) {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End" && matches.length) {
                event.preventDefault();
                setActiveIndex(matches.length - 1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeMerchant) choose(activeMerchant);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closePicker(true);
              }
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30"
          />

          {error ? (
            <p className="px-2 py-2 text-xs text-status-bad" role="alert">{error}</p>
          ) : null}
          {loading && activeMerchants.length === 0 ? (
            <output className="block px-2 py-3 text-sm text-muted-foreground">Loading merchants…</output>
          ) : null}

          <div
            id={listboxId}
            role="listbox"
            aria-label="Bookable merchants"
            className="mt-1 max-h-56 overflow-y-auto py-1"
          >
            {matches.map((merchant, index) => (
              <button
                key={merchant.id}
                id={`${listboxId}-option-${merchant.id}`}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={merchant.id === value}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => choose(merchant)}
                className={`flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ${
                  index === activeIndex ? "bg-muted" : ""
                }`}
              >
                <span className="min-w-0 truncate">{merchant.name}</span>
                {!merchant.codEnabled ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    COD disabled
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {!loading && !error && matches.length === 0 ? (
            <output className="block px-2 py-3 text-sm text-muted-foreground">
              {activeMerchants.length === 0
                ? "No active merchants are available."
                : "No merchants match your search."}
            </output>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
