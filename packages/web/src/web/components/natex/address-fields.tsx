import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DISTRICTS, provinceForDistrict, type AddressParts, type District } from "@/lib/address";

export function AddressFields({
  value,
  onChange,
  required = true,
  title = "Address",
}: {
  value: AddressParts;
  onChange: (value: AddressParts) => void;
  required?: boolean;
  title?: string;
}) {
  const update = (patch: Partial<AddressParts>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="label-xs mb-1 text-muted-foreground">{title}</legend>
      <p className="-mt-1 text-[11px] text-muted-foreground">Enter each part normally; commas are added automatically.</p>
      <Field label="Address line 1">
        <Input value={value.line1} onChange={(e) => update({ line1: e.target.value })} autoComplete="address-line1" required={required} />
      </Field>
      <Field label="Address line 2" hint="Optional — apartment, floor, landmark, etc.">
        <Input value={value.line2} onChange={(e) => update({ line2: e.target.value })} autoComplete="address-line2" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="District">
          <Select
            value={value.district}
            onChange={(e) => {
              const district = e.target.value as District | "";
              update({ district, province: provinceForDistrict(district) });
            }}
            required={required}
          >
            <option value="">Select district…</option>
            {DISTRICTS.map((district) => <option key={district} value={district}>{district}</option>)}
          </Select>
        </Field>
        <Field label="Province (auto-selected)">
          <Input value={value.province} placeholder="Select district first" readOnly aria-label="Province selected from district" />
        </Field>
      </div>
    </fieldset>
  );
}
