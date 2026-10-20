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
