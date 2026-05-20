// Beacon — Pharos lighthouse logo adapted for the callout strip. Mirrors the
// structure of /public/pharos-icon.svg (shield + beams + detailed lighthouse)
// but uses `currentColor` everywhere so the parent's brand-accent tint flows
// through. Opacity layering preserves the depth the gradient fills gave the
// original asset.

import type { JSX } from "react";

export function BeaconEmblem(): JSX.Element {
  return (
    <svg
      viewBox="0 0 88 88"
      width={45}
      height={45}
      fill="none"
      aria-hidden="true"
    >
      {/* Lantern glow */}
      <circle cx="44" cy="16" r="14" fill="currentColor" opacity={0.12} />

      {/* Beams — narrow to wide, drawn before the shield so the shield can mask the crossings */}
      <line x1="44" y1="16" x2="44" y2="-4" stroke="currentColor" strokeWidth={2.5} opacity={0.55} strokeLinecap="round" />
      <line x1="44" y1="16" x2="22" y2="-2" stroke="currentColor" strokeWidth={2.5} opacity={0.4} strokeLinecap="round" />
      <line x1="44" y1="16" x2="66" y2="-2" stroke="currentColor" strokeWidth={2.5} opacity={0.4} strokeLinecap="round" />
      <line x1="44" y1="16" x2="4" y2="4" stroke="currentColor" strokeWidth={2} opacity={0.25} strokeLinecap="round" />
      <line x1="44" y1="16" x2="84" y2="4" stroke="currentColor" strokeWidth={2} opacity={0.25} strokeLinecap="round" />
      <line x1="44" y1="16" x2="-4" y2="14" stroke="currentColor" strokeWidth={1.5} opacity={0.15} strokeLinecap="round" />
      <line x1="44" y1="16" x2="92" y2="14" stroke="currentColor" strokeWidth={1.5} opacity={0.15} strokeLinecap="round" />

      {/* Shield outline */}
      <path
        d="M14,8 L74,8 L74,36 Q74,74 44,84 Q14,74 14,36 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        opacity={0.55}
        strokeLinejoin="round"
      />

      {/* Lighthouse — lantern light */}
      <circle cx="44" cy="16" r="5" fill="currentColor" opacity={0.95} />

      {/* Dome */}
      <path d="M39,22 C39,14 49,14 49,22 Z" fill="currentColor" opacity={0.9} />

      {/* Lantern room */}
      <rect x="38.5" y="22" width="11" height="7" rx="1" fill="currentColor" opacity={0.85} />

      {/* Gallery */}
      <rect x="34" y="29" width="20" height="4" rx="1.5" fill="currentColor" opacity={0.85} />

      {/* Tower shaft */}
      <path d="M37,33 L51,33 L54,66 L34,66 Z" fill="currentColor" opacity={0.8} />

      {/* Tower bands */}
      <line x1="36.2" y1="44" x2="52.2" y2="44" stroke="currentColor" strokeWidth={2} opacity={0.35} />
      <line x1="35.3" y1="55" x2="53.1" y2="55" stroke="currentColor" strokeWidth={2} opacity={0.35} />

      {/* Base — two stacked plinths */}
      <rect x="30" y="66" width="28" height="5" rx="2.5" fill="currentColor" opacity={0.7} />
      <rect x="26" y="71" width="36" height="5" rx="2.5" fill="currentColor" opacity={0.45} />
    </svg>
  );
}
