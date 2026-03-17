"use client";

/**
 * Live region component for data announcements.
 * Render this once at the app level to announce data updates to screen readers.
 */
export function DataLiveRegion() {
  return (
    <div
      id="pharos-data-live-region"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      role="status"
    />
  );
}
