// Beacon — Pharos lighthouse: tapered tower, lamp room, light source, and two
// symmetric levels of signal beams at consistent angles to read as broadcast.

import type { JSX } from "react";

export function BeaconEmblem(): JSX.Element {
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
      <path
        d="M9.5 21 L10.5 11 H13.5 L14.5 21 Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M8.5 21 H15.5" />
      <path d="M10 11 H14" opacity={0.55} />
      <rect x="9.75" y="8.5" width="4.5" height="2.5" rx="0.4" />
      <circle cx="12" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <path d="M8 4.5 L10 6" opacity={0.65} />
      <path d="M16 4.5 L14 6" opacity={0.65} />
      <path d="M5 6 L8.5 6.5" opacity={0.4} />
      <path d="M19 6 L15.5 6.5" opacity={0.4} />
    </svg>
  );
}
