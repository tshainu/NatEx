import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DISTRICTS_BY_PROVINCE, PROVINCES, type AddressParts, type Province } from "@/lib/address";

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
  const districts = value.province ? DISTRICTS_BY_PROVINCE[value.province as Province] : [];
  const update = (patch: Partial<AddressParts>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="label-xs mb-1 text-muted-foreground">{title}</legend>
      <Field label="Address line 1">
        <Input value={value.line1} onChange={(e) => update({ line1: e.target.value })} autoComplete="address-line1" required={required} />
      </Field>
      <Field label="Address line 2" hint="Optional — apartment, floor, landmark, etc.">
        <Input value={value.line2} onChange={(e) => update({ line2: e.target.value })} autoComplete="address-line2" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Province">
          <Select
            value={value.province}
            onChange={(e) => update({ province: e.target.value as Province | "", district: "" })}
            required={required}
          >
            <option value="">Select province…</option>
            {PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}
          </Select>
        </Field>
        <Field label="District">
          <Select
            value={value.district}
            onChange={(e) => update({ district: e.target.value as AddressParts["district"] })}
            required={required}
            disabled={!value.province}
          >
            <option value="">Select district…</option>
            {districts.map((district) => <option key={district} value={district}>{district}</option>)}
          </Select>
        </Field>
      </div>
    </fieldset>
  );
}
