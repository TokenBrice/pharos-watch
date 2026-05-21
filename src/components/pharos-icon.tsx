import type { LucideIcon, LucideProps } from "lucide-react";

/* ─── Icon size ladder ──────────────────────────────────────────────
 *
 * Three documented roles for Lucide-based iconography. Stick to these
 * sizes when adopting <PharosIcon>; metaphor-heavy surfaces (cemetery,
 * harbor) deliberately diverge for narrative weight and should stay
 * bespoke.
 *
 *   micro   (12px) — inside chips, small badges
 *   default (16px) — inline with text, default size
 *   lead    (20px) — primary actions, hero icons
 *
 * Default stroke weight is 1.5 (Linear/Vercel convention) instead of
 * Lucide's stock 2 — the lighter weight is the single biggest
 * contributor to "considered" vs. "generic SaaS" icon feel.
 * ──────────────────────────────────────────────────────────────────── */

export const ICON_SIZE = {
  micro: 12,
  default: 16,
  lead: 20,
} as const;

export type PharosIconSize = keyof typeof ICON_SIZE;

export interface PharosIconProps extends Omit<LucideProps, "size" | "strokeWidth"> {
  icon: LucideIcon;
  size?: PharosIconSize;
  strokeWidth?: number;
}

export function PharosIcon({
  icon: Icon,
  size = "default",
  strokeWidth = 1.5,
  ...rest
}: PharosIconProps) {
  return <Icon size={ICON_SIZE[size]} strokeWidth={strokeWidth} {...rest} />;
}
