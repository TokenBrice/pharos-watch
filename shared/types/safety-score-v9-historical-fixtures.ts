import { z } from "zod";
import {
  IsoTimestampSchema,
  V9QualityPillarSchema,
  V9StructuralSignalKindSchema,
} from "./safety-score-v9";

const HistoricalV9FixtureBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    assetId: z.string().min(1),
    asOf: IsoTimestampSchema,
    factsVersion: z.literal(1),
    facts: z
      .object({
        archetype: z.string().min(1),
        implementationAgeMonths: z.number().finite().nonnegative(),
        signals: z.array(z.string().min(1)),
        riskSignals: z.array(
          z
            .object({
              pillar: V9QualityPillarSchema,
              kind: V9StructuralSignalKindSchema,
              severity: z.enum(["low", "moderate", "high", "critical"]),
              reason: z.string().min(1),
            })
            .strict(),
        ),
        unresolvedCriticalFacts: z.array(z.string().min(1)),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1),
            url: z.string().url(),
            publishedAt: IsoTimestampSchema,
            supports: z.array(z.string().min(1)).min(1),
            capture: z
              .object({
                status: z.enum(["content-addressed", "archived", "immutable-url", "unarchived"]),
                capturedAt: IsoTimestampSchema.optional(),
                archivedUrl: z.string().url().optional(),
                contentSha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
                note: z.string().min(1).optional(),
              })
              .strict()
              .superRefine((capture, ctx) => {
                if (capture.status === "content-addressed" && !capture.contentSha256) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["contentSha256"],
                    message: "Content-addressed historical sources require a SHA-256 digest",
                  });
                }
                if (capture.status === "archived" && !capture.archivedUrl) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["archivedUrl"],
                    message: "Archived historical sources require their archive URL",
                  });
                }
              }),
          })
          .strict(),
      )
      .min(1),
    factFreeze: z
      .object({
        role: z.literal("facts-curator"),
        reviewer: z.string().min(1),
        frozenAt: IsoTimestampSchema,
        outcomeAccess: z.enum(["withheld", "not-attested"]),
        attestation: z.string().min(1),
      })
      .strict(),
    outcome: z
      .object({
        classification: z.enum(["adverse", "resilient"]),
        categories: z.array(z.enum(["backing", "exit", "control", "dependency", "peg-incident", "survivor"])).min(1),
        observedFrom: IsoTimestampSchema,
        observedThrough: IsoTimestampSchema,
        summary: z.string().min(1),
      })
      .strict(),
    outcomeAnnotation: z
      .object({
        role: z.literal("outcome-annotator"),
        reviewer: z.string().min(1),
        annotatedAt: IsoTimestampSchema,
        factSetVersion: z.literal(1),
        attestation: z.string().min(1),
      })
      .strict(),
    blinding: z
      .object({
        mode: z.enum(["independent-reviewers", "role-separated-fact-freeze", "retrospective-unverified"]),
        rationale: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const HistoricalV9FixtureSchema = HistoricalV9FixtureBaseSchema.superRefine((fixture, ctx) => {
  const asOfMs = Date.parse(fixture.asOf);
  fixture.sources.forEach((source, index) => {
    if (Date.parse(source.publishedAt) > asOfMs) {
      ctx.addIssue({
        code: "custom",
        path: ["sources", index, "publishedAt"],
        message: `Look-ahead evidence: source was published after fixture asOf ${fixture.asOf}`,
      });
    }
  });
  if (Date.parse(fixture.outcome.observedThrough) < Date.parse(fixture.outcome.observedFrom)) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome", "observedThrough"],
      message: "Outcome observation window is reversed",
    });
  }
  if (fixture.outcome.classification === "adverse" && Date.parse(fixture.outcome.observedFrom) < asOfMs) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome", "observedFrom"],
      message: "Adverse fixture asOf must not follow the adverse outcome",
    });
  }
  if (Date.parse(fixture.factFreeze.frozenAt) < asOfMs) {
    ctx.addIssue({
      code: "custom",
      path: ["factFreeze", "frozenAt"],
      message: "Fact freeze cannot predate the point-in-time observation date",
    });
  }
  if (Date.parse(fixture.outcomeAnnotation.annotatedAt) < Date.parse(fixture.factFreeze.frozenAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["outcomeAnnotation", "annotatedAt"],
      message: "Outcome annotation cannot predate the frozen fact set",
    });
  }
  if (
    fixture.blinding.mode === "independent-reviewers" &&
    fixture.factFreeze.reviewer === fixture.outcomeAnnotation.reviewer
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["blinding", "mode"],
      message: "Independent-reviewers mode requires distinct facts and outcome reviewers",
    });
  }
});


export const HistoricalV9FixtureCorpusSchema = z
  .object({ schemaVersion: z.literal(1), fixtures: z.array(HistoricalV9FixtureSchema).min(24) })
  .strict()
  .superRefine((corpus, ctx) => {
    const ids = new Set<string>();
    corpus.fixtures.forEach((fixture, index) => {
      if (ids.has(fixture.id)) {
        ctx.addIssue({ code: "custom", path: ["fixtures", index, "id"], message: "Duplicate fixture ID" });
      }
      ids.add(fixture.id);
    });
    const adverse = corpus.fixtures.filter((fixture) => fixture.outcome.classification === "adverse").length;
    const resilient = corpus.fixtures.length - adverse;
    if (adverse < 12) {
      ctx.addIssue({ code: "custom", path: ["fixtures"], message: "Corpus requires at least 12 adverse fixtures" });
    }
    if (resilient < 12) {
      ctx.addIssue({ code: "custom", path: ["fixtures"], message: "Corpus requires at least 12 resilient fixtures" });
    }
  });
