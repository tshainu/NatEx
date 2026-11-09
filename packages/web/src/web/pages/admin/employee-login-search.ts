export interface EmployeeLoginSearchOption {
  id: string;
  employeeCode: string;
  fullName: string;
  phone: string | null;
  branchId: string;
  branchName: string | null;
}

/** Filter the eligible login options already returned by the identity API. */
export function filterEmployeeLoginOptions<T extends EmployeeLoginSearchOption>(
  options: readonly T[],
  search: string,
): T[] {
  const term = search.trim().toLowerCase();
  if (!term) return [...options];

  return options.filter((option) =>
    [option.fullName, option.employeeCode, option.phone, option.branchName, option.branchId].some(
      (value) => value?.toLowerCase().includes(term),
    ),
  );
}
