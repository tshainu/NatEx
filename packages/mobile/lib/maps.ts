export interface MerchantMapLocation {
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
}

export function hasValidCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function formatCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string | null {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !hasValidCoordinates(latitude, longitude)
  ) {
    return null;
  }
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

/** Google Maps universal directions URL; app links open the native Maps app when available. */
export function googleMapsDirectionsUrl(location: MerchantMapLocation): string | null {
  const hasCoordinates =
    typeof location.latitude === "number" &&
    typeof location.longitude === "number" &&
    hasValidCoordinates(location.latitude, location.longitude);
  const destination = hasCoordinates
    ? `${location.latitude},${location.longitude}`
    : location.address?.trim();

  if (!destination) return null;

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}
