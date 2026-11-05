import { afterAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../database";
import { hrEmployee } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import * as hr from "./service";
import { nextEmployeeCode } from "./employee-number";

const RUN = Date.now().toString(36).toUpperCase();
const actor: Principal = {
  userId: `usr_hr_number_test_${RUN}`,
  name: "HR employee-number integration test",
  role: "hr",
  roles: ["hr"],
  branchId: "",
};
const employeeIds: string[] = [];

afterAll(async () => {
  if (employeeIds.length) await db.delete(hrEmployee).where(inArray(hrEmployee.id, employeeIds));
});

test("concurrent employee creates receive distinct consecutive automatic numbers", async () => {
  const priorCodes = (await db.select({ employeeCode: hrEmployee.employeeCode }).from(hrEmployee))
    .map((row) => row.employeeCode);
  const expectedCodes: string[] = [];
  const sequence = [...priorCodes];
  for (let index = 0; index < 8; index += 1) {
    const expectedCode = nextEmployeeCode(sequence);
    expectedCodes.push(expectedCode);
    sequence.push(expectedCode);
  }

  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => hr.createEmployee({
    fullName: `Concurrent employee number test ${RUN} ${index}`,
    branchId: `test_branch_${RUN}`,
    department: "Operations",
    jobTitle: "Coordinator",
    employmentType: "permanent",
    joinedOn: "2026-11-05",
    primaryEmployment: true,
    overtimePolicy: "none",
    overtimeMultiplierBps: 15_000,
    overtimeDivisorMinutes: 14_400,
  }, actor)));

  const created = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  employeeIds.push(...created.map((employee) => employee.id));
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  const codes = created.map((employee) => employee.employeeCode);
  expect(new Set(codes).size).toBe(8);
  expect([...codes].sort((a, b) => Number(BigInt(a.slice(3)) - BigInt(b.slice(3)))))
    .toEqual([...expectedCodes].sort((a, b) => Number(BigInt(a.slice(3)) - BigInt(b.slice(3)))));
});
