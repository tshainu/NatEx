export interface SalaryAssignmentForEdit {
  assignment: {
    packageId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  };
}

/** Find the package covering an effective date, preserving effective-dated history semantics. */
export function salaryPackageAtDate(assignments: readonly SalaryAssignmentForEdit[], effectiveFrom: string): string | null {
  const current = assignments
    .filter(({ assignment }) =>
      assignment.effectiveFrom <= effectiveFrom &&
      (assignment.effectiveTo === null || assignment.effectiveTo >= effectiveFrom),
    )
    .sort((a, b) => b.assignment.effectiveFrom.localeCompare(a.assignment.effectiveFrom))[0];
  return current?.assignment.packageId ?? null;
}

/** Avoid creating a duplicate history row when the selected package is already in force. */
export function shouldAssignSalaryPackage(
  assignments: readonly SalaryAssignmentForEdit[],
  packageId: string,
  effectiveFrom: string,
): boolean {
  return salaryPackageAtDate(assignments, effectiveFrom) !== packageId;
}
