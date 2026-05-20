import { z } from "zod";

// Wire schemas for the /api/events endpoint backed by the `tape_events` D1
// table.

export const TAPE_EVENT_SEVERITY_VALUES = [
  "info",
  "notice",
  "warning",
  "severe",
  "critical",
] as const;

const TapeEventSeveritySchema = z.enum(TAPE_EVENT_SEVERITY_VALUES);
export type TapeEventSeverity = z.infer<typeof TapeEventSeveritySchema>;

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

const TAPE_EVENT_TRANSITION_VALUES = [
  "opened",
  "updated",
  "resolved",
  "snapshot",
] as const;

const TapeEventTransitionSchema = z.enum(TAPE_EVENT_TRANSITION_VALUES);
export type TapeEventTransition = z.infer<typeof TapeEventTransitionSchema>;

const TapeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: TapeEventSeveritySchema,
  ts: z.number(),
  endsAt: z.number().nullable(),
  coinId: z.string().nullable(),
  issuerId: z.string().nullable(),
  pegCurrency: z.string().nullable(),
  chain: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
  sourceTable: z.string(),
  sourceRowId: z.string(),
  transition: TapeEventTransitionSchema,
  sourceUrl: z.string().nullable(),
  methodologyVersion: z.string().nullable(),
});
export type TapeEvent = z.infer<typeof TapeEventSchema>;

const TapeEventsResponseMetaSchema = z.object({
  updatedAt: z.number(),
  ageSeconds: z.number(),
  status: z.enum(["fresh", "degraded", "stale"]),
});
export type TapeEventsResponseMeta = z.infer<typeof TapeEventsResponseMetaSchema>;

export const TapeEventsResponseSchema = z.object({
  events: z.array(TapeEventSchema),
  nextCursor: z.string().nullable(),
  total: z.number().nullable(),
  totalExact: z.boolean(),
  _meta: TapeEventsResponseMetaSchema,
});
export type TapeEventsResponse = z.infer<typeof TapeEventsResponseSchema>;
