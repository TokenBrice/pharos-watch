import { z } from "zod";

const RECENT_EVENT_SEVERITY_VALUES = [
  "info",
  "notice",
  "warning",
  "severe",
  "critical",
] as const;

const RECENT_EVENT_TYPE_VALUES = [
  "depeg.opened",
  "depeg.resolved",
  "freeze.blocked",
  "freeze.unblocked",
  "freeze.destroyed",
  "score.upgraded",
  "score.downgraded",
  "score.regrade.bulk",
] as const;

const RecentEventSeveritySchema = z.enum(RECENT_EVENT_SEVERITY_VALUES);
export type RecentEventSeverity = z.infer<typeof RecentEventSeveritySchema>;

const RecentEventTypeSchema = z.enum(RECENT_EVENT_TYPE_VALUES);

const RecentEventSchema = z.object({
  id: z.string(),
  type: RecentEventTypeSchema,
  severity: RecentEventSeveritySchema,
  ts: z.number(),
  stablecoinId: z.string().nullable(),
  symbol: z.string().nullable(),
  title: z.string(),
  href: z.string(),
});
export type RecentEvent = z.infer<typeof RecentEventSchema>;

export const RecentEventsResponseSchema = z.object({
  events: z.array(RecentEventSchema),
});
export type RecentEventsResponse = z.infer<typeof RecentEventsResponseSchema>;
