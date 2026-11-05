import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "@/lib/api";
import { Field, Input } from "@/components/ui/input";
import { ErrorNote, SuccessNote } from "@/components/natex/page";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png"] as const;

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "HR";
}

export function EmployeeProfilePhoto({ employeeId, fullName }: { employeeId: string; fullName: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = React.useState<string | null>(null);
  const photo = useQuery({ ...orpc.hr.employeePhotoView.queryOptions({ input: { employeeId } }) });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!file.name || file.size < 1 || file.size > MAX_PHOTO_BYTES) throw new Error("Choose a non-empty JPEG or PNG photo no larger than 5 MB.");
      if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) throw new Error("Employee photos must be JPEG or PNG files.");
      const input = {
        employeeId,
        fileName: file.name,
        contentType: file.type as (typeof PHOTO_TYPES)[number],
        sizeBytes: file.size,
      };
      const slot = await client.hr.employeePhotoUpload(input);
      const response = await fetch(slot.uploadUrl, { method: "PUT", headers: { "content-type": input.contentType }, body: file });
      if (!response.ok) throw new Error(`The photo upload failed (HTTP ${response.status}). Try again.`);
      return client.hr.attachEmployeePhoto({ ...input, storageRef: slot.storageRef });
    },
    onSuccess: (document) => {
      setNotice(`${document.fileName} was saved as the current employee photo.`);
      void queryClient.invalidateQueries({ queryKey: orpc.hr.employeePhotoView.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.hr.employeeDocuments.key() });
    },
  });

  return (
    <div className="mb-5 flex flex-wrap items-center gap-4 rounded-md border border-border/70 p-4">
      {photo.data?.url
        ? <img src={photo.data.url} alt={`${fullName} profile`} className="h-24 w-24 rounded-full border border-border object-cover" />
        : <div aria-label={`No photo uploaded for ${fullName}`} className="flex h-24 w-24 items-center justify-center rounded-full border border-dashed border-border bg-muted text-xl font-semibold text-muted-foreground">{initials(fullName)}</div>}
      <div className="min-w-[220px] flex-1 space-y-2">
        <div><h3 className="text-[14px] font-semibold">Employee photo</h3><p className="text-[12px] text-muted-foreground">Upload or replace a JPEG/PNG image, up to 5 MB. It is stored privately for HR/Admin; the preview link expires after five minutes.</p></div>
        <Field label={photo.data?.url ? "Replace photo" : "Upload photo"}>
          <Input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={upload.isPending} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) { setNotice(null); upload.mutate(file); } }} />
        </Field>
        {notice ? <SuccessNote>{notice}</SuccessNote> : null}
        {upload.error ? <ErrorNote>{apiMessage(upload.error, "The employee photo could not be uploaded.")}</ErrorNote> : null}
        {photo.error ? <ErrorNote>{apiMessage(photo.error, "The employee photo could not be loaded.")}</ErrorNote> : null}
      </div>
    </div>
  );
}
