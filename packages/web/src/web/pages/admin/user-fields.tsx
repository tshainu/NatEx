import { ROLE_LABEL } from "@/lib/permissions";
import type { Role } from "@/lib/session";
import { Field } from "@/components/ui/input";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const ALL_ROLES: Role[] = ["rider", "transport", "ops", "finance", "admin", "merchant", "hr"];
export const OFFICIAL_ROLES: Role[] = ["rider", "transport", "ops", "finance", "admin", "hr"];

/**
 * Highest privilege first: when several roles are checked the earliest in this
 * order becomes the primary role (home portal, branch scope).
 */
const PRIMARY_ORDER: Role[] = ["admin", "finance", "hr", "ops", "merchant", "transport", "rider"];

export function orderRoles(selected: readonly Role[]): Role[] {
  return PRIMARY_ORDER.filter((r) => selected.includes(r));
}

/**
 * Multi-role picker (checkboxes — a user may hold several roles). The first
 * role in privilege order is primary: it decides the home portal and branch
 * scope. The server enforces every route against the whole set.
 */
export function RoleCheckboxGroup({
  value,
  onChange,
  disabled,
  roles = ALL_ROLES,
}: {
  value: Role[];
  onChange: (roles: Role[]) => void;
  disabled?: boolean;
  roles?: Role[];
}) {
  function toggle(role: Role) {
    const next = value.includes(role) ? value.filter((r) => r !== role) : [...value, role];
    onChange(orderRoles(next));
  }
  const primary = value[0];
  return (
    <Field
      label="Roles"
      hint={
        value.length > 1
          ? `${ROLE_LABEL[primary!]} is the primary role — it decides the home portal and branch scope.`
          : "Tick every role this user holds."
      }
    >
      <div className="grid grid-cols-2 gap-2">
        {roles.map((role) => {
          const checked = value.includes(role);
          return (
            <label
              key={role}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px]",
                checked ? "border-brand bg-brand/10 font-medium" : "border-border",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                aria-label={`${ROLE_LABEL[role]} role`}
                className="size-3.5 accent-emerald-500"
                checked={checked}
                disabled={disabled || (checked && value.length === 1)}
                onChange={() => toggle(role)}
              />
              {ROLE_LABEL[role]}
              {checked && role === primary && value.length > 1 ? (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">primary</span>
              ) : null}
            </label>
          );
        })}
      </div>
    </Field>
  );
}

/**
 * Username/password credentials for web and mobile app sign-in. Blank password
 * keeps the current one when editing; on create, blank means phone-OTP only.
 */
export function CredentialsFields({
  username,
  password,
  onUsername,
  onPassword,
  editing,
}: {
  username: string;
  password: string;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
  editing?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-md border border-border p-3">
      <legend className="px-1 font-display text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground">
        App sign-in
      </legend>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Username" hint={editing ? "Blank keeps sign-in phone-only." : "Optional. Lowercased."}>
          <Input
            value={username}
            onChange={(e) => onUsername(e.target.value)}
            placeholder="e.g. karthik"
            autoComplete="off"
            className="font-mono"
          />
        </Field>
        <Field
          label="Password"
          hint={editing ? "Blank keeps the current password." : "At least 6 characters."}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            placeholder={editing ? "Unchanged" : ""}
            autoComplete="new-password"
            className="font-mono"
          />
        </Field>
      </div>
      <p className="text-[12px] text-muted-foreground">
        With a username and password set, the user can sign in on the mobile app and the web without
        waiting for an SMS code. Setting or changing a password signs the user out everywhere.
      </p>
    </fieldset>
  );
}
