import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, SuccessNote } from "@/components/natex/page";
import { HR_CONTROL_CLASS } from "./shared";

const CATEGORIES = [
  ["employment", "Employment agreement"],
  ["identity", "Identity document"],
  ["education", "Education / qualification"],
  ["banking", "Banking / payroll"],
  ["medical", "Medical"],
  ["other", "Other"],
] as const;
type Category = (typeof CATEGORIES)[number][0];
const MAX_BYTES = 10 * 1024 * 1024;

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function EmployeeDocuments({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient();
  const [category, setCategory] = React.useState<Category>("employment");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [viewLink, setViewLink] = React.useState<{ id: string; url: string } | null>(null);
  const documents = useQuery({ ...orpc.hr.employeeDocuments.queryOptions({ input: { employeeId } }) });
  const upload = useMutation({
    mutationFn: async ({ file, documentCategory }: { file: File; documentCategory: Category }) => {
      if (!file.name || file.size < 1 || file.size > MAX_BYTES) throw new Error("Choose a non-empty file no larger than 10 MB.");
      if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) throw new Error("Only PDF, JPEG and PNG documents are accepted.");
      const input = { employeeId, category: documentCategory, fileName: file.name, contentType: file.type as "application/pdf" | "image/jpeg" | "image/png", sizeBytes: file.size };
      const slot = await client.hr.employeeDocumentUpload(input);
      const response = await fetch(slot.uploadUrl, { method: "PUT", headers: { "content-type": input.contentType }, body: file });
      if (!response.ok) throw new Error(`The document upload failed (HTTP ${response.status}). Try again.`);
      return client.hr.attachEmployeeDocument({ ...input, storageRef: slot.storageRef });
    },
    onSuccess: (document) => {
      setNotice(`${document.fileName} was added to the employee record.`);
      setViewLink(null);
      void queryClient.invalidateQueries({ queryKey: orpc.hr.employeeDocuments.key() });
    },
  });

  async function view(documentId: string) {
    setNotice(null);
    try {
      const result = await client.hr.employeeDocumentView({ documentId });
      setViewLink({ id: documentId, url: result.url });
    } catch (error) {
      setNotice(apiMessage(error, "The document link could not be created. Try again."));
    }
  }

  return (
    <Card title="Employee documents" description="HR/Admin only. Original files are stored in object storage; the database retains metadata and opaque references. View links expire after a few minutes.">
      {notice ? <SuccessNote>{notice}</SuccessNote> : null}
      {upload.error ? <ErrorNote>{apiMessage(upload.error, "The employee document could not be uploaded.")}</ErrorNote> : null}
      <form className="mb-5 grid gap-3 rounded-md border border-border/70 p-3 md:grid-cols-[180px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("employee-document-file"); if (input instanceof HTMLInputElement && input.files?.[0]) upload.mutate({ file: input.files[0], documentCategory: category }); }}>
        <Field label="Document category"><select className={HR_CONTROL_CLASS} value={category} onChange={(event) => setCategory(event.target.value as Category)}>{CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="File (PDF, JPEG, PNG · max 10 MB)"><Input name="employee-document-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required disabled={upload.isPending} /></Field>
        <div className="self-end"><Button type="submit" pending={upload.isPending}>Upload document</Button></div>
      </form>
      <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Document</th><th className="p-2">Category</th><th className="p-2">Size</th><th className="p-2">Added</th><th className="p-2"><span className="sr-only">Action</span></th></tr></thead><tbody>{(documents.data ?? []).map((document) => <tr key={document.id} className="border-b border-border/60"><td className="p-2 font-medium">{document.fileName}</td><td className="p-2">{CATEGORIES.find(([value]) => value === document.category)?.[1] ?? document.category}</td><td className="p-2 font-mono">{fileSize(document.sizeBytes)}</td><td className="p-2">{new Date(document.createdAt).toLocaleDateString("en-LK")}</td><td className="p-2">{viewLink?.id === document.id ? <a className="text-brand underline" href={viewLink.url} target="_blank" rel="noreferrer">Open document</a> : <Button size="sm" variant="outline" onClick={() => void view(document.id)}>Create view link</Button>}</td></tr>)}</tbody></table>{!documents.isPending && (documents.data?.length ?? 0) === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No documents have been uploaded for this employee.</p> : null}</div>
      {documents.error ? <ErrorNote>{apiMessage(documents.error, "Employee documents could not be loaded.")}</ErrorNote> : null}
    </Card>
  );
}
