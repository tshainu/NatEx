import { and, desc, eq } from "drizzle-orm";
import { db } from "../../database";
import { hrEmployeeDocument } from "../../database/schema/hr";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { presignGet, presignPut } from "../../shared/storage";
import { getEmployee } from "./service";

export const HR_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const HR_DOCUMENT_CATEGORIES = [
  "employment",
  "identity",
  "education",
  "banking",
  "medical",
  "other",
] as const;
export const HR_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const extensionByType: Record<(typeof HR_DOCUMENT_TYPES)[number], string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

function safeFileName(fileName: string): string {
  const safe = fileName.trim().replace(/[\\/]/g, "_").split("").map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? "_" : character;
  }).join("").slice(0, 180);
  if (!safe || safe === "." || safe === "..") errors.badRequest("Enter a valid employee-document file name.");
  return safe;
}

function validateDocument(contentType: string, sizeBytes: number): asserts contentType is (typeof HR_DOCUMENT_TYPES)[number] {
  if (!(HR_DOCUMENT_TYPES as readonly string[]).includes(contentType)) {
    errors.badRequest("Employee documents must be PDF, JPEG or PNG files.");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > HR_DOCUMENT_MAX_BYTES) {
    errors.badRequest("Employee documents must be between 1 byte and 10 MB.");
  }
}

export async function createEmployeeDocumentUpload(input: {
  employeeId: string;
  category: (typeof HR_DOCUMENT_CATEGORIES)[number];
  fileName: string;
  contentType: (typeof HR_DOCUMENT_TYPES)[number];
  sizeBytes: number;
}) {
  await getEmployee(input.employeeId);
  validateDocument(input.contentType, input.sizeBytes);
  const fileName = safeFileName(input.fileName);
  const key = `hr/employees/${input.employeeId}/${prefixedId("doc")}.${extensionByType[input.contentType]}`;
  return {
    ...(await presignPut(key, input.contentType)),
    fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  };
}

export async function attachEmployeeDocument(input: {
  employeeId: string;
  category: (typeof HR_DOCUMENT_CATEGORIES)[number];
  fileName: string;
  contentType: (typeof HR_DOCUMENT_TYPES)[number];
  sizeBytes: number;
  storageRef: string;
}, actorId: string) {
  await getEmployee(input.employeeId);
  validateDocument(input.contentType, input.sizeBytes);
  const fileName = safeFileName(input.fileName);
  const expectedPrefix = `s3:hr/employees/${input.employeeId}/`;
  const expectedSuffix = `.${extensionByType[input.contentType]}`;
  if (!input.storageRef.startsWith(expectedPrefix) || !input.storageRef.endsWith(expectedSuffix) || input.storageRef.length > 300) {
    errors.badRequest("That upload does not belong to this employee or file type.");
  }
  const [row] = await db.insert(hrEmployeeDocument).values({
    id: prefixedId("hed"),
    employeeId: input.employeeId,
    category: input.category,
    fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageRef: input.storageRef,
    createdBy: actorId,
  }).returning();
  return row!;
}

export async function listEmployeeDocuments(employeeId: string) {
  await getEmployee(employeeId);
  return db.select({
    id: hrEmployeeDocument.id,
    employeeId: hrEmployeeDocument.employeeId,
    category: hrEmployeeDocument.category,
    fileName: hrEmployeeDocument.fileName,
    contentType: hrEmployeeDocument.contentType,
    sizeBytes: hrEmployeeDocument.sizeBytes,
    createdAt: hrEmployeeDocument.createdAt,
  }).from(hrEmployeeDocument).where(eq(hrEmployeeDocument.employeeId, employeeId)).orderBy(desc(hrEmployeeDocument.createdAt));
}

export async function employeeDocumentView(documentId: string) {
  const [row] = await db.select().from(hrEmployeeDocument).where(eq(hrEmployeeDocument.id, documentId));
  if (!row) errors.notFound("Employee document");
  await getEmployee(row!.employeeId);
  return { ...(await presignGet(row!.storageRef)), fileName: row!.fileName, contentType: row!.contentType };
}

export async function employeeDocumentForAudit(input: { employeeId: string; documentId: string }) {
  const [row] = await db.select({ id: hrEmployeeDocument.id }).from(hrEmployeeDocument).where(and(
    eq(hrEmployeeDocument.id, input.documentId),
    eq(hrEmployeeDocument.employeeId, input.employeeId),
  ));
  if (!row) errors.notFound("Employee document");
  return row!;
}
