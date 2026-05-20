// Liquidity — vessel with a curved meniscus. A flask-like silhouette half-filled
// with a fluid surface that curves up at the walls (the meniscus — a literal
// liquidity term), plus a faint deeper tide line. Avoids the droplet motif.

import type { JSX } from "react";

export function LiquidityEmblem(): JSX.Element {
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
      <path d="M8 3.5 H16" />
      <path d="M9 3.5 V9 L5.5 17 A3.5 3.5 0 0 0 8.7 21.5 H15.3 A3.5 3.5 0 0 0 18.5 17 L15 9 V3.5" />
      <path d="M6.6 14.5 C8.5 13.2 10.5 15.2 12 14.5 C13.5 13.8 15.5 13.2 17.4 14.5 L17.4 17 A3 3 0 0 1 14.6 19.5 H9.4 A3 3 0 0 1 6.6 17 Z" fill="currentColor" stroke="none" opacity={0.5} />
      <path d="M6.6 14.5 C8.5 13.2 10.5 15.2 12 14.5 C13.5 13.8 15.5 13.2 17.4 14.5" />
    </svg>
  );
}
