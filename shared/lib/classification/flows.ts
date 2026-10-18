import type { MintBurnCoverageStatus } from "../../types/mint-burn";
import type { GaugeBand } from "../mint-burn-gauge-bands";
import type { MintPressureBand } from "../classification";

/**
 * Mint/burn flow presentation. Mint is emerald and burn red; value text uses
 * the house `700/400` pair everywhere (owner ruling C9).
 */

export const MINT_PRESSURE_TONE_CLASSES = {
  "no-activity": {
    badge: "border-border/70 bg-muted/40 text-muted-foreground",
    value: "text-muted-foreground",
    panel: "border-border/60 bg-background/35",
  },
  "mint-dominated": {
    badge:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    value: "text-emerald-700 dark:text-emerald-400",
    panel: "border-emerald-600/30 bg-emerald-500/10 dark:border-emerald-500/35 dark:bg-emerald-500/10",
  },
  "mint-tilt": {
    badge:
      "border-lime-600/30 bg-lime-500/10 text-lime-700 dark:border-lime-500/40 dark:bg-lime-500/15 dark:text-lime-300",
    value: "text-lime-700 dark:text-lime-400",
    panel: "border-lime-600/30 bg-lime-500/10 dark:border-lime-500/35 dark:bg-lime-500/10",
  },
  balanced: {
    badge: "border-border/70 bg-muted/40 text-foreground",
    value: "text-foreground",
    panel: "border-border/60 bg-background/40",
  },
  "burn-tilt": {
    badge:
      "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
    value: "text-amber-700 dark:text-amber-400",
    panel: "border-amber-600/30 bg-amber-500/10 dark:border-amber-500/35 dark:bg-amber-500/10",
  },
  "burn-dominated": {
    badge:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    value: "text-red-700 dark:text-red-400",
    panel: "border-red-600/30 bg-red-500/10 dark:border-red-500/35 dark:bg-red-500/10",
  },
} as const satisfies Record<MintPressureBand, { badge: string; value: string; panel: string }>;

/** Event-feed badges (colour only; the feed adds its own `text-xs`). */
export const FLOW_EVENT_BADGE_CLASSES = {
  roundtrip: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bridgeTransfer: "border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  protocolInternal: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  reviewBurn: "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  mint: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  burn: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400",
} as const;

/** Receipt band and top minter/burner value text. */
export const FLOW_RECEIPT_TONE_CLASSES = {
  mint: "text-emerald-700 dark:text-emerald-400",
  burn: "text-red-700 dark:text-red-400",
} as const;

/** Minting-pressure arc gauge value text at the burn and mint ends (the middle stays foreground). */
export const MINT_GAUGE_ZONE_TEXT_CLASSES = {
  burn: "text-red-700 dark:text-red-400",
  mint: "text-emerald-700 dark:text-emerald-400",
} as const;

/** Coverage caveat badges; `full` shows none and `disabled` is neutral, so neither is listed. */
export const FLOW_COVERAGE_BADGE_CLASSES = {
  "partial-history": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  lagging: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  bootstrapping: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  unknown: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
} as const satisfies Record<Exclude<MintBurnCoverageStatus, "full" | "disabled">, string>;

/**
 * Bank Run Gauge band display labels (sentence case) and tones. Stress bands
 * carry danger/warn, the neutral band stays ink, and inflow bands carry the
 * positive tone; the band name is always printed, so tone is never the only cue.
 */
export const GAUGE_BAND_LABELS = {
  CRISIS: "Crisis",
  STRESS: "Stress",
  CAUTIOUS: "Cautious",
  NEUTRAL: "Neutral",
  HEALTHY: "Healthy",
  CONFIDENT: "Confident",
  SURGE: "Surge",
} as const satisfies Record<GaugeBand, string>;

export const GAUGE_BAND_TONE_CLASSES = {
  CRISIS: "border-state-danger bg-state-danger-subtle text-state-danger-strong",
  STRESS: "border-state-danger bg-state-danger-subtle text-state-danger-strong",
  CAUTIOUS: "border-state-warn bg-state-warn-subtle text-state-warn-strong",
  NEUTRAL: "border-border bg-muted/40 text-foreground",
  HEALTHY: "border-state-positive bg-state-positive-subtle text-state-positive-strong",
  CONFIDENT: "border-state-positive bg-state-positive-subtle text-state-positive-strong",
  SURGE: "border-state-positive bg-state-positive-subtle text-state-positive-strong",
} as const satisfies Record<GaugeBand, string>;
