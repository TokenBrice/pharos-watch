// Selector — four-point compass rose with a clear north hierarchy and a
// half-opacity secondary 4-point register for depth without busy-ness.

import type { JSX } from "react";

export function SelectorEmblem(): JSX.Element {
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
      <circle cx="12" cy="12" r="9" opacity={0.4} />
      <path
        d="M12 3 L13.5 12 L12 13 L10.5 12 Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M12 21 L10.5 12 L12 11 L13.5 12 Z" opacity={0.55} />
      <path d="M3 12 L12 10.5 L13 12 L12 13.5 Z" opacity={0.55} />
      <path d="M21 12 L12 13.5 L11 12 L12 10.5 Z" opacity={0.55} />
      <path d="M6.5 6.5 L11.3 11.3" opacity={0.35} />
      <path d="M17.5 6.5 L12.7 11.3" opacity={0.35} />
      <path d="M6.5 17.5 L11.3 12.7" opacity={0.35} />
      <path d="M17.5 17.5 L12.7 12.7" opacity={0.35} />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
