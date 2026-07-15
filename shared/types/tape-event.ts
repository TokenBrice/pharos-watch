import { z } from "zod";
import { TAPE_EVENT_SEVERITY_VALUES, TAPE_EVENT_TRANSITION_VALUES } from "./tape-event-constants";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";

// Wire schemas for the /api/events endpoint backed by the `tape_events` D1
// table. The Zod-free display constants and simple types live in
// `tape-event-constants.ts` and are re-exported here so existing importers of
// this module keep working unchanged.

export * from "./tape-event-constants";

const TapeEventSeveritySchema = z.enum(TAPE_EVENT_SEVERITY_VALUES);

const TapeEventTransitionSchema = z.enum(TAPE_EVENT_TRANSITION_VALUES);

/** Provenance embedded in score.upgraded and score.downgraded payloads. */
export const SafetyScoreTapeProvenanceSchema = z.discriminatedUnion("identityStatus", [
  z
    .object({
      identityStatus: z.literal("complete"),
      identity: SafetyScorePublicationIdentitySchema,
    })
    .strict(),
  z
    .object({
      identityStatus: z.literal("legacy-v8-unidentified"),
      identity: z.null(),
    })
    .strict(),
]);
export type SafetyScoreTapeProvenance = z.infer<typeof SafetyScoreTapeProvenanceSchema>;

export const ScoreTapeEventPayloadSchema = z.object({
  prevGrade: z.string(),
  newGrade: z.string(),
  prevScore: z.number().nullable(),
  newScore: z.number().nullable(),
  safetyScore: SafetyScoreTapeProvenanceSchema,
});
export type ScoreTapeEventPayload = z.infer<typeof ScoreTapeEventPayloadSchema>;

export const TapeEventSchema = z
  .object({
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
  })
  .superRefine((event, ctx) => {
    if (event.type !== "score.upgraded" && event.type !== "score.downgraded") return;

    const payload = ScoreTapeEventPayloadSchema.safeParse(event.payload);
    if (!payload.success) {
      for (const issue of payload.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: ["payload", ...issue.path],
          message: issue.message,
        });
      }
      return;
    }

    if (
      payload.data.safetyScore.identityStatus === "legacy-v8-unidentified" &&
      event.sourceTable !== "safety_grade_history"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "safetyScore", "identityStatus"],
        message: "Legacy safety-score provenance is only valid for safety_grade_history events",
      });
    }
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
