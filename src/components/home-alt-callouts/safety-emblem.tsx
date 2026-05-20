// Safety — heater-shield crest with two inscribed chevron tiers and a crest pip.
// The silhouette curves inward at the shoulders and tapers to a chape (point),
// reading more "crest" than generic safety shield.

import type { JSX } from "react";

export function SafetyEmblem(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={36}
      height={36}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 L19.5 5.2 C19.5 5.2 19.5 11 19.2 13.4 C18.7 17.4 15.6 20 12 21 C8.4 20 5.3 17.4 4.8 13.4 C4.5 11 4.5 5.2 4.5 5.2 Z" />
      <circle cx="12" cy="5.6" r="0.9" fill="currentColor" stroke="none" />
      <path d="M7.5 11.5 L12 13.5 L16.5 11.5" opacity={0.6} />
      <path d="M8.5 15 L12 16.5 L15.5 15" opacity={0.4} />
    </svg>
  );
}
