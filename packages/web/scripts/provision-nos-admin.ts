import { and, eq } from "drizzle-orm";
import { db } from "../src/api/database";
import { branch, user } from "../src/api/database/schema/identity";
import { hashSecret } from "../src/api/shared/auth";
import { normaliseLkPhone } from "../src/api/shared/sms";
import { normaliseUsername } from "../src/api/modules/identity/service";

const username = normaliseUsername(process.env.NOSADMIN_USERNAME ?? "nosadmin");
const password = process.env.NOSADMIN_PASSWORD;
const phoneInput = process.env.NOSADMIN_PHONE;
const name = process.env.NOSADMIN_NAME ?? "NOS Admin";

if (!password || password.length < 12) throw new Error("NOSADMIN_PASSWORD must be set and contain at least 12 characters.");
if (!phoneInput) throw new Error("NOSADMIN_PHONE must be set to a valid required phone number.");
const phone = normaliseLkPhone(phoneInput);
if (phone.length < 9) throw new Error("NOSADMIN_PHONE is invalid.");

const [existing] = await db.select().from(user).where(eq(user.username, username));
const branchId = process.env.NOSADMIN_BRANCH_ID ?? existing?.branchId;
if (!existing) {
  let selectedBranchId = branchId;
  if (!selectedBranchId) {
  const [firstBranch] = await db.select({ id: branch.id }).from(branch).where(eq(branch.status, "active")).limit(1);
  if (!firstBranch) throw new Error("No active branch exists; set NOSADMIN_BRANCH_ID explicitly.");
    selectedBranchId = firstBranch.id;
  }
  const passwordHash = await hashSecret(password);
  const [created] = await db.insert(user).values({
    id: `usr_nos_admin_${crypto.randomUUID()}`,
    branchId: selectedBranchId,
    role: "nos_admin",
    roles: JSON.stringify(["nos_admin"]),
    name,
    phone,
    username,
    passwordHash,
    status: "active",
  }).returning({ id: user.id });
  console.log(`Provisioned NOS Admin ${username} (${created!.id}); MFA is required and first login will require authenticator enrollment.`);
} else {
  const passwordHash = await hashSecret(password);
  const [updated] = await db.update(user).set({
    branchId,
    role: "nos_admin",
    roles: JSON.stringify(["nos_admin"]),
    name,
    phone,
    passwordHash,
    status: "active",
    merchantId: null,
  }).where(and(eq(user.id, existing.id), eq(user.username, username))).returning({ id: user.id });
  if (!updated) throw new Error("NOS Admin update was not applied.");
  console.log(`Updated NOS Admin ${username} (${updated.id}); MFA is required and existing enrollment was preserved.`);
}
