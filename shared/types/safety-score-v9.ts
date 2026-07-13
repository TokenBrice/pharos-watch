import { z } from "zod";

export const V9QualityPillarSchema = z.enum(["backing", "exit", "control"]);
export type V9QualityPillar = z.infer<typeof V9QualityPillarSchema>;

export const V9EvidenceLevelSchema = z.enum(["strong", "adequate", "limited", "insufficient"]);
export type V9EvidenceLevel = z.infer<typeof V9EvidenceLevelSchema>;

export const V9GradeSchema = z.enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"]);
export type V9Grade = z.infer<typeof V9GradeSchema>;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const ScoreSchema = z.number().finite().min(0).max(100);

export const V9UnresolvedFactSchema = z
  .object({
    code: z.string().min(1),
    reason: z.string().min(1),
    critical: z.boolean(),
    path: z.string().min(1).optional(),
  })
  .strict();
export type V9UnresolvedFact = z.infer<typeof V9UnresolvedFactSchema>;

export const V9EvidenceReferenceSchema = z
  .object({
    sourceId: z.string().min(1),
    observedAt: IsoTimestampSchema,
    publishedAt: IsoTimestampSchema.optional(),
    url: z.string().url().optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type V9EvidenceReference = z.infer<typeof V9EvidenceReferenceSchema>;

export const V9PillarEvidenceSchema = z
  .object({
    score: ScoreSchema.nullable(),
    evidenceLevel: V9EvidenceLevelSchema,
    evidence: z.array(V9EvidenceReferenceSchema),
    unresolved: z.array(V9UnresolvedFactSchema),
    signals: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.score === null && !value.unresolved.some((fact) => fact.critical)) {
      ctx.addIssue({
        code: "custom",
        path: ["unresolved"],
        message: "A missing pillar score requires a critical unresolved reason",
      });
    }
    if (value.score !== null && value.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A scored pillar requires at least one evidence reference",
      });
    }
  });
export type V9PillarEvidence = z.infer<typeof V9PillarEvidenceSchema>;

export const V9StructuralSignalKindSchema = z.enum([
  "unsafe-backing",
  "speculative-credit",
  "algorithmic-reflexivity",
  "centralized-mint",
  "unreviewed-upgrade",
  "material-bridge",
  "peripheral-bridge",
  "weak-oracle-branch",
  "active-control-incident",
  "critical-dependency",
  "bounded-unknown",
]);
export type V9StructuralSignalKind = z.infer<typeof V9StructuralSignalKindSchema>;

export const V9StructuralSignalSchema = z
  .object({
    kind: V9StructuralSignalKindSchema,
    severity: z.enum(["low", "moderate", "high", "critical"]),
    reason: z.string().min(1),
    materialSharePct: z.number().finite().min(0).max(100).optional(),
    failureDomainKeys: z.array(z.string().min(1)).default([]),
    evidence: z.array(V9EvidenceReferenceSchema).default([]),
  })
  .strict();
export type V9StructuralSignal = z.infer<typeof V9StructuralSignalSchema>;

export const CompiledV9AssetInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: z.string().min(1),
    asOf: IsoTimestampSchema,
    compiledAt: IsoTimestampSchema,
    archetype: z.string().min(1).nullable(),
    pillars: z.object({
      backing: V9PillarEvidenceSchema,
      exit: V9PillarEvidenceSchema,
      control: V9PillarEvidenceSchema,
    }),
    peg: z
      .object({
        applicable: z.boolean(),
        score: ScoreSchema.nullable(),
        activeDepegBps: z.number().finite().nonnegative().nullable(),
        evidence: z.array(V9EvidenceReferenceSchema),
        unresolved: z.array(V9UnresolvedFactSchema),
      })
      .strict(),
    implementationLaunchDate: z.string().date().nullable(),
    trackRecordMonths: z.number().finite().nonnegative(),
    parent: z
      .object({
        assetId: z.string().min(1),
        required: z.boolean(),
        relationship: z.enum(["wrapper", "mechanism", "variant"]),
      })
      .strict()
      .nullable(),
    structuralSignals: z.array(V9StructuralSignalSchema),
    unresolved: z.array(V9UnresolvedFactSchema),
    sourceTimestamps: z.record(z.string().min(1), IsoTimestampSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const asOfMs = Date.parse(value.asOf);
    if (Date.parse(value.compiledAt) < asOfMs) {
      ctx.addIssue({
        code: "custom",
        path: ["compiledAt"],
        message: "compiledAt cannot be earlier than asOf",
      });
    }
    for (const [source, timestamp] of Object.entries(value.sourceTimestamps)) {
      if (Date.parse(timestamp) > asOfMs) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceTimestamps", source],
          message: "Source observation cannot be later than asOf",
        });
      }
    }
    const references = [
      ...Object.values(value.pillars).flatMap((pillar) => pillar.evidence),
      ...value.peg.evidence,
      ...value.structuralSignals.flatMap((signal) => signal.evidence),
    ];
    references.forEach((reference, index) => {
      if (
        Date.parse(reference.observedAt) > asOfMs ||
        (reference.publishedAt && Date.parse(reference.publishedAt) > asOfMs)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index],
          message: "Compiled evidence cannot be observed or published later than asOf",
        });
      }
    });
  });
export type CompiledV9AssetInput = z.infer<typeof CompiledV9AssetInputSchema>;

export const V9ScoringInputSchema = z
  .object({
    assetId: z.string().min(1),
    pillars: z.object({
      backing: ScoreSchema.nullable(),
      exit: ScoreSchema.nullable(),
      control: ScoreSchema.nullable(),
    }),
    pegScore: ScoreSchema.nullable(),
    pegApplicable: z.boolean(),
    evidenceLevel: V9EvidenceLevelSchema,
    trackRecordMonths: z.number().finite().nonnegative(),
    activeDepegBps: z.number().finite().nonnegative().nullable(),
    parentRequired: z.boolean(),
    parentScore: ScoreSchema.nullable(),
    structuralCaps: z.array(
      z.object({ kind: z.string().min(1), limit: ScoreSchema, reason: z.string().min(1) }).strict(),
    ),
    structuralSignals: z.array(V9StructuralSignalSchema),
    unresolved: z.array(V9UnresolvedFactSchema),
  })
  .strict();
export type V9ScoringInput = z.infer<typeof V9ScoringInputSchema>;

export const HistoricalV9FixtureSchema = z
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
          })
          .strict(),
      )
      .min(1),
    outcome: z
      .object({
        classification: z.enum(["adverse", "resilient"]),
        categories: z.array(z.enum(["backing", "exit", "control", "dependency", "peg-incident", "survivor"])).min(1),
        observedFrom: IsoTimestampSchema,
        observedThrough: IsoTimestampSchema,
        summary: z.string().min(1),
      })
      .strict(),
    provenance: z
      .object({
        reviewer: z.string().min(1),
        reviewedAt: IsoTimestampSchema,
        rationale: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, ctx) => {
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
  });
export type HistoricalV9Fixture = z.infer<typeof HistoricalV9FixtureSchema>;

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
export type HistoricalV9FixtureCorpus = z.infer<typeof HistoricalV9FixtureCorpusSchema>;
