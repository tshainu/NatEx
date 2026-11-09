import { describe, expect, test } from "bun:test";
import {
  filterEmployeeLoginOptions,
  type EmployeeLoginSearchOption,
} from "./employee-login-search";

const employees: EmployeeLoginSearchOption[] = [
  {
    id: "employee-1",
    employeeCode: "N26001",
    fullName: "Amara Perera",
    phone: "+94771234567",
    branchId: "branch-colombo",
    branchName: "Colombo Central",
  },
  {
    id: "employee-2",
    employeeCode: "N26002",
    fullName: "Ravi Silva",
    phone: null,
    branchId: "branch-kandy",
    branchName: "Kandy Hub",
  },
];

describe("employee login option search", () => {
  test("matches name, employee number, phone, and branch case-insensitively", () => {
    expect(
      filterEmployeeLoginOptions(employees, "  AMARA ").map((employee) => employee.id),
    ).toEqual(["employee-1"]);
    expect(filterEmployeeLoginOptions(employees, "n26002").map((employee) => employee.id)).toEqual([
      "employee-2",
    ]);
    expect(
      filterEmployeeLoginOptions(employees, "+94771234567").map((employee) => employee.id),
    ).toEqual(["employee-1"]);
    expect(filterEmployeeLoginOptions(employees, "KANDY").map((employee) => employee.id)).toEqual([
      "employee-2",
    ]);
  });

  test("keeps all options for a blank query and returns none for a non-match", () => {
    expect(filterEmployeeLoginOptions(employees, "  ")).toEqual(employees);
    expect(filterEmployeeLoginOptions(employees, "no such employee")).toEqual([]);
  });
});
