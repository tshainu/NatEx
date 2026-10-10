import { z } from "zod";
import { hrProc, mutate } from "../middleware/pipeline";
import * as documents from "../modules/hr/documents";

const category = z.enum(documents.HR_DOCUMENT_CATEGORIES);
const contentType = z.enum(documents.HR_DOCUMENT_TYPES);
const documentInput = z.object({
  employeeId: z.string().min(1),
  category,
  fileName: z.string().trim().min(1).max(240),
  contentType,
  sizeBytes: z.number().int().min(1).max(documents.HR_DOCUMENT_MAX_BYTES),
});

export const employeeDocuments = hrProc
  .input(z.object({ employeeId: z.string().min(1) }))
  .handler(({ input }) => documents.listEmployeeDocuments(input.employeeId));

export const employeeDocumentUpload = hrProc.input(documentInput).handler(({ input, context }) =>
  mutate(context, input, {
    route: "hr.employeeDocumentUpload",
    entity: "hr_employee_document",
    entityId: () => input.employeeId,
    action: "hr.employee_document_upload_slot_created",
    idempotency: false,
  }, () => documents.createEmployeeDocumentUpload(input)),
);

export const attachEmployeeDocument = hrProc.input(documentInput.extend({ storageRef: z.string().min(8).max(300) })).handler(({ input, context }) =>
  mutate(context, input, {
    route: "hr.attachEmployeeDocument",
    entity: "hr_employee_document",
    entityId: (row) => (row as { id: string }).id,
    action: "hr.employee_document_attached",
  }, () => documents.attachEmployeeDocument(input, context.principal.userId)),
);

export const employeeDocumentView = hrProc
  .input(z.object({ documentId: z.string().min(1) }))
  .handler(({ input }) => documents.employeeDocumentView(input.documentId));

export const hrDocuments = { employeeDocuments, employeeDocumentUpload, attachEmployeeDocument, employeeDocumentView };
