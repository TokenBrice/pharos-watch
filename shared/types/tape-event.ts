import { z } from "zod";

// Wire schemas for the /api/events endpoint backed by the `tape_events` D1
// table. Kept separate from `shared/types/tape.ts` (which models the
// frontend-tape recent-events feed) so the two evolve independently.

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
