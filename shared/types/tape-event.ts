import { z } from "zod";
import {
  TAPE_EVENT_SEVERITY_VALUES,
  TAPE_EVENT_TRANSITION_VALUES,
} from "./tape-event-constants";

// Wire schemas for the /api/events endpoint backed by the `tape_events` D1
// table. The Zod-free display constants and simple types live in
// `tape-event-constants.ts` and are re-exported here so existing importers of
// this module keep working unchanged.

export * from "./tape-event-constants";

const TapeEventSeveritySchema = z.enum(TAPE_EVENT_SEVERITY_VALUES);

const TapeEventTransitionSchema = z.enum(TAPE_EVENT_TRANSITION_VALUES);

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

export const TapeEventsResponseSchema = z.object({
  events: z.array(TapeEventSchema),
  nextCursor: z.string().nullable(),
  total: z.number().nullable(),
  totalExact: z.boolean(),
  _meta: TapeEventsResponseMetaSchema,
});
export type TapeEventsResponse = z.infer<typeof TapeEventsResponseSchema>;
