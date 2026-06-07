// Zod-free runtime constants and types for tape events. Split out of
// `tape-event.ts` so modules that only need the display constants/types (e.g.
// the eagerly-rendered homepage tape strip) don't drag the Zod schema runtime
// into the initial homepage bundle. The Zod wire schemas live in
// `tape-event.ts`, which re-exports everything here.

export const TAPE_EVENT_SEVERITY_VALUES = [
  "info",
  "notice",
  "warning",
  "severe",
  "critical",
] as const;

export type TapeEventSeverity = (typeof TAPE_EVENT_SEVERITY_VALUES)[number];

export const SEVERITY_RANK: Record<TapeEventSeverity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  severe: 3,
  critical: 4,
};

// Bare display labels for severity. Used where the label stands alone (e.g. a
// dot tooltip on the homepage tape strip).
export const SEVERITY_LABEL: Record<TapeEventSeverity, string> = {
  info: "Info",
  notice: "Notice",
  warning: "Warning",
  severe: "Severe",
  critical: "Critical",
};

// "Plus"-suffixed variant used where the label denotes a severity floor (chip
// in the tape filter row, summary chips above the event list). The trailing
// `+` reads as "this tier and above" and reinforces the floor semantic.
export const SEVERITY_LABEL_INCLUSIVE: Record<TapeEventSeverity, string> = {
  info: "Info+",
  notice: "Notice+",
  warning: "Warning+",
  severe: "Severe+",
  critical: "Critical",
};

// Text-color classes per severity. Tailwind requires static strings, so the
// map is fully enumerated rather than templated.
export const SEVERITY_TEXT_CLASS: Record<TapeEventSeverity, string> = {
  info: "text-zinc-600 dark:text-zinc-400",
  notice: "text-sky-700 dark:text-sky-400",
  warning: "text-amber-700 dark:text-amber-400",
  severe: "text-orange-700 dark:text-orange-400",
  critical: "text-red-700 dark:text-red-400",
};

// Background-color classes per severity, used for severity dots on the strip.
export const SEVERITY_DOT_CLASS: Record<TapeEventSeverity, string> = {
  info: "bg-emerald-500",
  notice: "bg-sky-500",
  warning: "bg-amber-500",
  severe: "bg-orange-500",
  critical: "bg-red-500",
};

export const TAPE_EVENT_TRANSITION_VALUES = [
  "opened",
  "updated",
  "resolved",
  "snapshot",
] as const;

export type TapeEventTransition = (typeof TAPE_EVENT_TRANSITION_VALUES)[number];
