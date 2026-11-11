import type { DigestForwardLookOutcome, DigestRiskTapeItem } from "../../types/digest";
import type { TapeEventSeverity } from "../../types/tape-event-constants";
import { projectDescriptors } from "./descriptors";

/** Zod-free display authority; severity ordering remains part of the wire vocabulary. */
export const TAPE_SEVERITY_PRESENTATION = {
  info: { label: "Info", textClass: "text-zinc-600 dark:text-zinc-400", dotClass: "bg-emerald-500" },
  notice: { label: "Notice", textClass: "text-sky-700 dark:text-sky-400", dotClass: "bg-sky-500" },
  warning: { label: "Warning", textClass: "text-amber-700 dark:text-amber-400", dotClass: "bg-amber-500" },
  severe: { label: "Severe", textClass: "text-orange-700 dark:text-orange-400", dotClass: "bg-orange-500" },
  critical: { label: "Critical", textClass: "text-red-700 dark:text-red-400", dotClass: "bg-red-500" },
} as const satisfies Record<TapeEventSeverity, { label: string; textClass: string; dotClass: string }>;

/** Standalone labels, including severity-dot tooltips. */
export const SEVERITY_LABEL = projectDescriptors(TAPE_SEVERITY_PRESENTATION, (tier) => tier.label);
/** A floor means this tier and above; the maximum tier needs no plus. */
export const SEVERITY_LABEL_INCLUSIVE = projectDescriptors(
  TAPE_SEVERITY_PRESENTATION,
  (tier) => tier === TAPE_SEVERITY_PRESENTATION.critical ? tier.label : `${tier.label}+`,
);
export const SEVERITY_TEXT_CLASS = projectDescriptors(TAPE_SEVERITY_PRESENTATION, (tier) => tier.textClass);
export const SEVERITY_DOT_CLASS = projectDescriptors(TAPE_SEVERITY_PRESENTATION, (tier) => tier.dotClass);

export const DIGEST_RISK_TAPE_TONE_CLASSES: Record<DigestRiskTapeItem["tone"], string> = {
  critical: "border-red-500/35 bg-red-500/10 text-red-800 dark:text-red-300",
  warning: "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  neutral: "border-border/70 bg-muted/40 text-foreground/80",
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
};

export const DIGEST_FORWARD_LOOK_OUTCOME_STYLES: Record<DigestForwardLookOutcome["status"], { label: string; className: string }> = {
  hit: { label: "Hit", className: "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" },
  missed: { label: "Missed", className: "border-border/70 bg-muted/35 text-muted-foreground" },
  pending: { label: "Pending", className: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300" },
  expired: { label: "Expired", className: "border-border/70 bg-muted/35 text-muted-foreground" },
  unavailable: { label: "Unavailable", className: "border-border/70 bg-muted/35 text-muted-foreground" },
};
