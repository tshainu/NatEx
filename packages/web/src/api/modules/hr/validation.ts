export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year! < 1900 || year! > 2100 || month! < 1 || month! > 12 || day! < 1 || day! > 31) return false;
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}


/** Local payroll/attendance wall-clock time, stored as HH:MM without a timezone. */
export function isValidLocalTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export const HR_PROFILE_PHOTO_TYPES = ["image/jpeg", "image/png"] as const;
export const HR_PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export function isValidEmployeeProfilePhoto(contentType: string, sizeBytes: number): boolean {
  return (HR_PROFILE_PHOTO_TYPES as readonly string[]).includes(contentType)
    && Number.isSafeInteger(sizeBytes)
    && sizeBytes > 0
    && sizeBytes <= HR_PROFILE_PHOTO_MAX_BYTES;
}
