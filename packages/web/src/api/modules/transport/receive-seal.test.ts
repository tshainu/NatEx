import { expect, test } from "bun:test";
import type { Principal } from "../../shared/auth";
import { receiveBag } from "./service";

if (!process.env.DATABASE_URL?.startsWith("file:/tmp/")) {
  throw new Error("receive-seal.test.ts must run with a disposable file:/tmp database URL");
}

const actor: Principal = {
  userId: "test-user",
  name: "Jaffna Hub Clerk",
  role: "transport",
  roles: ["transport"],
  branchId: "test-jaffna-branch",
};

const invalidSeals: Array<{ label: string; value: string | null | undefined }> = [
  { label: "missing", value: undefined },
  { label: "null", value: null },
  { label: "empty", value: "" },
  { label: "whitespace-only", value: "   " },
];

for (const { label, value } of invalidSeals) {
  test(`rejects a ${label} seal before accessing the bag`, async () => {
    const input = {
      bagId: "bag-must-not-be-read",
      scannedAwbs: [],
      sealNumber: value,
      releasedByName: "Origin Clerk",
    } as unknown as Parameters<typeof receiveBag>[0];

    await expect(receiveBag(input, actor)).rejects.toThrow(
      "A bag seal number is required before recording receipt.",
    );
  });
}
