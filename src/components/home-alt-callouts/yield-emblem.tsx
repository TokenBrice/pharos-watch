import type { JSX } from "react";

// Yield — capital sprouting growth. A coin at the base, a stem rising through
// the center, two branches diverging into yield fruits, and an apex pip. The
// coin + sprout pair reads instantly as "value compounds out of principal,"
// avoiding both the bar-chart and the spiral-that-looks-like-a-letter pitfalls.
export function YieldEmblem(): JSX.Element {
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
      {/* Principal — the coin at the base */}
      <circle cx="12" cy="19.5" r="2.25" fill="currentColor" stroke="none" />
      {/* Main stem rising out of the coin */}
      <path d="M12 17.25 V7.5" />
      {/* Left branch curling out to a yield fruit */}
      <path d="M12 13 C8.5 12.5 7 10.5 7 8" opacity={0.7} />
      <circle cx="7" cy="7.5" r="1.1" fill="currentColor" stroke="none" opacity={0.7} />
      {/* Right branch — staggered higher to read as compounding */}
      <path d="M12 10 C15.5 9.5 17 7.5 17 5" opacity={0.55} />
      <circle cx="17" cy="4.5" r="1.1" fill="currentColor" stroke="none" opacity={0.55} />
      {/* Apex — the highest yield outcome */}
      <circle cx="12" cy="6" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
