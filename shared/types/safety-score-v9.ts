import { z } from "zod";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";

export const V9QualityPillarSchema = z.enum(["backing", "exit", "control"]);
export type V9QualityPillar = z.infer<typeof V9QualityPillarSchema>;

export const V9EvidenceLevelSchema = z.enum(["strong", "adequate", "limited", "insufficient"]);
export type V9EvidenceLevel = z.infer<typeof V9EvidenceLevelSchema>;

export const V9GradeSchema = z.enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"]);
export type V9Grade = z.infer<typeof V9GradeSchema>;

export const V9_REASON_CODES = [
  "bounded-mechanism-review",
  "bounded-unknown-reserve-exposure",
  "correlated-exit-routes",
  "critical-unresolved",
  "future-dated-input-fact",
  "historical-critical-input",
  "immaterial-unrecognized-chain-pool",
  "implementation-parent-cycle",
  "incomparable-route-requests",
  "incomplete-dex-route-coverage",
  "incomplete-oracle-liquidation-branch",
  "insufficient-evidence",
  "material-bridge-supply-unmatched",
  "material-dependency-unavailable",
  "material-reserve-slice-unstructured",
  "material-unknown-reserve-exposure",
  "mint-control-question",
  "missing-applicable-peg",
  "missing-archetype",
  "missing-bridge-route-rows",
  "missing-bridge-routes",
  "missing-custody-profile",
  "missing-implementation-date",
  "missing-latest-assurance-report",
  "missing-mint-authority",
  "missing-oracle-profile",
  "missing-parent-score",
  "missing-peg-input",
  "missing-pillar",
  "missing-access-review",
  "missing-pillar-evidence",
  "missing-required-oracle-branches",
  "missing-reserve-composition",
  "missing-runtime-route-evidence",
  "missing-same-notional-route",
  "missing-upgrade-control",
  "missing-upgradeability-review",
  "nonmaterial-dependency-unavailable",
  "no-viable-exit-path",
  "parent-cycle",
  "partial-reserve-review",
  "runtime-bridge-materiality-unavailable",
  "selected-bridge-route-missing",
  "selected-bridge-route-unresolved",
  "unknown-control-cap-authority",
  "unknown-control-mint-ability",
  "unknown-upgrade-authority",
  "unresolved-control-identity",
  "unresolved-exit-output",
  "unresolved-mint-authority",
  "unresolved-oracle-branch-applicability",
  "unsupported-same-notional-route",
  "unreviewed-dependency-relationships",
  "unreviewed-oracle-profile",
  "unreviewed-reserve-envelope",
] as const;
export const V9ReasonCodeSchema = z.enum(V9_REASON_CODES);
export type V9ReasonCode = z.infer<typeof V9ReasonCodeSchema>;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const ScoreSchema = z.number().finite().min(0).max(100);

export const V9UnresolvedFactSchema = z
  .object({
    code: V9ReasonCodeSchema,
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
]);
export type V9StructuralSignalKind = z.infer<typeof V9StructuralSignalKindSchema>;

export const V9SeveritySchema = z.enum(["low", "moderate", "high", "critical"]);
export type V9Severity = z.infer<typeof V9SeveritySchema>;

export const V9StructuralSignalSchema = z
  .object({
    kind: V9StructuralSignalKindSchema,
    severity: V9SeveritySchema,
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
    compilerPolicy: z
      .object({
        policyId: z.string().min(1),
        semanticDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
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
    structuralSignals: z.array(V9StructuralSignalSchema),
    unresolved: z.array(V9UnresolvedFactSchema),
  })
  .strict();
export type V9ScoringInput = z.infer<typeof V9ScoringInputSchema>;

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
export type HistoricalV9Fixture = z.infer<typeof HistoricalV9FixtureSchema>;

/**
 * The only historical input accepted by the scorer. Outcome labels and their
 * annotation provenance are intentionally absent so no caller can pass them
 * through the compiler boundary.
 */
export const HistoricalV9FactsInputSchema = HistoricalV9FixtureBaseSchema.pick({
  schemaVersion: true,
  id: true,
  assetId: true,
  asOf: true,
  factsVersion: true,
  facts: true,
  sources: true,
  factFreeze: true,
}).strict();
export type HistoricalV9FactsInput = z.infer<typeof HistoricalV9FactsInputSchema>;

export function historicalFactsInput(fixture: HistoricalV9Fixture): HistoricalV9FactsInput {
  return HistoricalV9FactsInputSchema.parse({
    schemaVersion: fixture.schemaVersion,
    id: fixture.id,
    assetId: fixture.assetId,
    asOf: fixture.asOf,
    factsVersion: fixture.factsVersion,
    facts: fixture.facts,
    sources: fixture.sources,
    factFreeze: fixture.factFreeze,
  });
}

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

export const V9CapSourceSchema = z.enum([
  "active-depeg",
  "structural",
  "parent",
  "evidence",
  "track-record",
  "bounded-compensability",
]);
export type V9CapSource = z.infer<typeof V9CapSourceSchema>;

export const V9PolicyTreatmentSchema = z.enum(["pillar", "ceiling", "NR", "diagnostic"]);
export type V9PolicyTreatment = z.infer<typeof V9PolicyTreatmentSchema>;

export const V9FactClassSchema = z.enum([
  "not-applicable",
  "known-current",
  "missing-bounded-exposure",
  "missing-global-bounded",
  "missing-serial-required",
  "optional-unsupported",
  "proved-no-viable-path",
  "applicability-unresolved",
  "stale-bounded",
  "stale-material",
]);
export type V9FactClass = z.infer<typeof V9FactClassSchema>;

export const V9BoundednessSchema = z.enum(["not-applicable", "exposure-bounded", "globally-bounded", "unbounded"]);
export type V9Boundedness = z.infer<typeof V9BoundednessSchema>;

export const V9PathKindSchema = z.enum([
  "serial-dependency",
  "collateral-exposure",
  "deployment-control",
  "optional-exit",
  "local-component",
  "peg",
  "methodology",
]);
export type V9PathKind = z.infer<typeof V9PathKindSchema>;

export const V9ReasonOwnerDomainSchema = z.enum([
  "backing",
  "exit",
  "control",
  "dependency",
  "peg",
  "evidence",
  "methodology",
]);
export type V9ReasonOwnerDomain = z.infer<typeof V9ReasonOwnerDomainSchema>;

export const V9ReasonReleaseSeveritySchema = z.enum(["diagnostic", "review-required", "release-blocker"]);
export type V9ReasonReleaseSeverity = z.infer<typeof V9ReasonReleaseSeveritySchema>;

export const V9ManualInputClassificationSchema = z.enum([
  "missing-data",
  "unresolved-methodology",
  "unsupported-design",
]);
export type V9ManualInputClassification = z.infer<typeof V9ManualInputClassificationSchema>;

const V9ReasonArchetypeSchema = z.union([z.literal("*"), z.enum(MECHANISM_ARCHETYPE_VALUES)]);
const V9ReasonPathKindSchema = z.union([z.literal("*"), V9PathKindSchema]);

export const V9NamedReasonCeilingKeySchema = z.enum([
  "control-unverified",
  "oracle-unverified",
  "backing-unverified",
  "exit-unverified",
  "peg-unverified",
]);
export type V9NamedReasonCeilingKey = z.infer<typeof V9NamedReasonCeilingKeySchema>;

export const V9ReasonCeilingRuleSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("evidence-level"), level: V9EvidenceLevelSchema }).strict(),
  z.object({ source: z.literal("minimum-track-record") }).strict(),
  z.object({ source: z.literal("named-ceiling"), key: V9NamedReasonCeilingKeySchema }).strict(),
]);
export type V9ReasonCeilingRule = z.infer<typeof V9ReasonCeilingRuleSchema>;

export const V9ReasonRegistryEntrySchema = z
  .object({
    code: V9ReasonCodeSchema,
    ownerDomain: V9ReasonOwnerDomainSchema,
    archetypes: z.array(V9ReasonArchetypeSchema).min(1),
    pathKinds: z.array(V9ReasonPathKindSchema).min(1),
    defaultFactClass: V9FactClassSchema,
    boundedness: V9BoundednessSchema,
    permittedTreatments: z.array(V9PolicyTreatmentSchema).min(1),
    defaultTreatment: V9PolicyTreatmentSchema,
    ceilingRule: V9ReasonCeilingRuleSchema.nullable().default(null),
    releaseSeverity: V9ReasonReleaseSeveritySchema,
    auditClassification: V9ManualInputClassificationSchema,
    publicLabel: z.string().min(1),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!entry.permittedTreatments.includes(entry.defaultTreatment)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultTreatment"],
        message: "Default treatment must be one of the permitted treatments",
      });
    }
    if ((entry.defaultTreatment === "ceiling") !== (entry.ceilingRule !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["ceilingRule"],
        message: "A ceiling rule is required exactly when the default treatment is ceiling",
      });
    }
    for (const [field, values] of [
      ["archetypes", entry.archetypes],
      ["pathKinds", entry.pathKinds],
      ["permittedTreatments", entry.permittedTreatments],
    ] as const) {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} cannot contain duplicates` });
      }
    }
  });
export type V9ReasonRegistryEntry = z.infer<typeof V9ReasonRegistryEntrySchema>;

export const V9FactDispositionSchema = z
  .object({
    factClass: V9FactClassSchema,
    boundedness: V9BoundednessSchema,
    defaultTreatment: V9PolicyTreatmentSchema,
    rateability: z.enum(["rateable", "NR"]),
    routeAction: z.enum(["include", "exclude", "not-applicable"]),
    publicLabel: z.string().min(1),
  })
  .strict();
export type V9FactDisposition = z.infer<typeof V9FactDispositionSchema>;

const NullableScoreSchema = ScoreSchema.nullable();
const V9SeverityScoreMapSchema = z
  .object({
    low: NullableScoreSchema,
    moderate: NullableScoreSchema,
    high: NullableScoreSchema,
    critical: NullableScoreSchema,
  })
  .strict();

const V9StructuralSignalLimitMapSchema = z
  .object({
    "unsafe-backing": V9SeverityScoreMapSchema,
    "speculative-credit": V9SeverityScoreMapSchema,
    "algorithmic-reflexivity": V9SeverityScoreMapSchema,
    "centralized-mint": V9SeverityScoreMapSchema,
    "unreviewed-upgrade": V9SeverityScoreMapSchema,
    "material-bridge": V9SeverityScoreMapSchema,
    "peripheral-bridge": V9SeverityScoreMapSchema,
    "weak-oracle-branch": V9SeverityScoreMapSchema,
    "active-control-incident": V9SeverityScoreMapSchema,
    "critical-dependency": V9SeverityScoreMapSchema,
  })
  .strict();

const V9ScoreBreakpointSchema = z.object({ value: z.number().finite().nonnegative(), score: ScoreSchema }).strict();
const V9MultiplierBandSchema = z
  .object({ threshold: z.number().finite().nonnegative(), multiplier: z.number().finite().min(0).max(1) })
  .strict();

const V9FormulaPolicySchema = z
  .object({
    pillarWeights: z
      .object({
        backing: z.number().finite().min(0).max(1),
        exit: z.number().finite().min(0).max(1),
        control: z.number().finite().min(0).max(1),
      })
      .strict(),
    compensabilityHeadroom: ScoreSchema,
    pegExponent: z.number().finite().min(0).max(1),
    pegHistoryWindowSec: z.number().int().positive(),
    pegQuietHistoryFloor: ScoreSchema,
    activeDepegCaps: z
      .array(
        z
          .object({
            minimumBps: z.number().finite().nonnegative(),
            limit: ScoreSchema,
            kind: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    trackRecordCeilings: z
      .array(
        z
          .object({
            minMonthsInclusive: z.number().finite().nonnegative(),
            maxMonthsExclusive: z.number().finite().positive().nullable(),
            limit: NullableScoreSchema,
            kind: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    gradeThresholds: z.array(z.object({ grade: V9GradeSchema.exclude(["NR"]), minScore: ScoreSchema }).strict()),
    capTiePriority: z.array(V9CapSourceSchema),
    scoreDecimals: z.number().int().min(0).max(6),
    rounding: z.object({ uncapped: z.literal("nearest"), capped: z.literal("floor") }).strict(),
  })
  .strict();

const V9EvidencePolicySchema = z
  .object({
    ceilings: z
      .object({
        strong: NullableScoreSchema,
        adequate: NullableScoreSchema,
        limited: NullableScoreSchema,
        insufficient: NullableScoreSchema,
      })
      .strict(),
    rank: z
      .object({
        strong: z.number().int().nonnegative(),
        adequate: z.number().int().nonnegative(),
        limited: z.number().int().nonnegative(),
        insufficient: z.number().int().nonnegative(),
      })
      .strict(),
    dispositions: z.array(V9FactDispositionSchema),
  })
  .strict();

const V9BackingSignalRuleSchema = z
  .object({
    kind: z.enum(["unsafe-backing", "speculative-credit", "algorithmic-reflexivity"]),
    severity: V9SeveritySchema,
  })
  .strict();

const V9BackingArchetypePolicySchema = z
  .object({
    reserveWeight: z.number().finite().min(0).max(1),
    componentWeights: z.record(z.string().min(1), z.number().finite().min(0).max(1)),
    serialComponentKeys: z.array(z.string().min(1)),
    structuralComponents: z.record(z.string().min(1), V9BackingSignalRuleSchema),
  })
  .strict();

const V9BackingPolicySchema = z
  .object({
    componentQuality: z
      .object({
        strong: ScoreSchema,
        adequate: ScoreSchema,
        limited: ScoreSchema,
        weak: ScoreSchema,
        failed: ScoreSchema,
      })
      .strict(),
    boundedUnknownQuality: ScoreSchema,
    reserve: z
      .object({
        assetClassQuality: z
          .object({
            cash: ScoreSchema,
            "bank-deposit": ScoreSchema,
            "treasury-bill": ScoreSchema,
            "government-security": ScoreSchema,
            repo: ScoreSchema,
            "money-market-fund": ScoreSchema,
            stablecoin: ScoreSchema,
            cryptoasset: ScoreSchema,
            "hedged-crypto": ScoreSchema,
            "private-credit": ScoreSchema,
            "public-credit": ScoreSchema,
            "tokenized-security": ScoreSchema,
            "fund-share": ScoreSchema,
            "protocol-position": ScoreSchema,
            other: ScoreSchema,
          })
          .strict(),
        liquidityQuality: z
          .object({
            immediate: ScoreSchema,
            "one-day": ScoreSchema,
            "seven-days": ScoreSchema,
            "over-seven-days": ScoreSchema,
            unknown: ScoreSchema,
          })
          .strict(),
        maturityNotApplicableClasses: z.array(
          z.enum([
            "cash",
            "bank-deposit",
            "treasury-bill",
            "government-security",
            "repo",
            "money-market-fund",
            "stablecoin",
            "cryptoasset",
            "hedged-crypto",
            "private-credit",
            "public-credit",
            "tokenized-security",
            "fund-share",
            "protocol-position",
            "other",
          ]),
        ),
        maturityBands: z
          .array(z.object({ maxDaysInclusive: z.number().int().nonnegative().nullable(), score: ScoreSchema }).strict())
          .min(1),
        factorWeights: z
          .object({
            assetQuality: z.number().finite().min(0).max(1),
            liquidity: z.number().finite().min(0).max(1),
            maturity: z.number().finite().min(0).max(1),
          })
          .strict(),
        issuerAttestedConfidenceMultiplier: z.number().finite().positive().max(1),
        concentrationWeight: z.number().finite().min(0).max(1),
        concentrationBands: z
          .array(z.object({ minShareInclusive: z.number().finite().min(0).max(1), score: ScoreSchema }).strict())
          .min(1),
      })
      .strict(),
    structural: z
      .object({
        materialExposureShare: z.number().finite().min(0).max(1),
        commonModeShare: z.number().finite().min(0).max(1),
        commonModeMinExposures: z.number().int().positive(),
        unsafeExposureQuality: ScoreSchema,
        severityShares: z
          .object({
            moderate: z.number().finite().min(0).max(1),
            high: z.number().finite().min(0).max(1),
            critical: z.number().finite().min(0).max(1),
          })
          .strict(),
        unsafeExposureSignal: V9BackingSignalRuleSchema,
        speculativeCreditSignal: V9BackingSignalRuleSchema,
        commonModeSignal: V9BackingSignalRuleSchema,
        nonSubstitutableFailureSignal: V9BackingSignalRuleSchema,
        algorithmic: z
          .object({ materialReflexiveShare: z.number().finite().min(0).max(1), signal: V9BackingSignalRuleSchema })
          .strict(),
        cdp: z
          .object({
            minimumCollateralizationRatio: z.number().finite().nonnegative(),
            instantaneousCollateralShock: z.number().finite().positive().max(1),
            minimumLiquidationCapacityRatio: z.number().finite().nonnegative(),
            stressMeasurementFreshness: z
              .object({
                maxAgeSec: z.number().int().positive(),
                ratification: z.literal("owner-ratified"),
                rationale: z.string().trim().min(1),
              })
              .strict(),
            collateralizationSignal: V9BackingSignalRuleSchema,
            liquidationSignal: V9BackingSignalRuleSchema,
          })
          .strict(),
        synthetic: z
          .object({
            minimumHedgeCoverageRatio: z.number().finite().nonnegative(),
            minimumLossAbsorptionShare: z.number().finite().min(0).max(1),
            hedgeSignal: V9BackingSignalRuleSchema,
            lossAbsorptionSignal: V9BackingSignalRuleSchema,
          })
          .strict(),
        rwaCreditFund: z
          .object({ maturityMismatchDays: z.number().int().nonnegative(), signal: V9BackingSignalRuleSchema })
          .strict(),
      })
      .strict(),
    archetypes: z
      .object({
        "fiat-cash": V9BackingArchetypePolicySchema,
        tbill: V9BackingArchetypePolicySchema,
        cdp: V9BackingArchetypePolicySchema,
        "synthetic-delta-neutral": V9BackingArchetypePolicySchema,
        algorithmic: V9BackingArchetypePolicySchema,
        "rwa-credit-fund": V9BackingArchetypePolicySchema,
      })
      .strict(),
  })
  .strict();

const V9ControlPolicySchema = z
  .object({
    mintPostureQuality: z
      .object({
        "none-resolved": ScoreSchema,
        "bounded-admin": ScoreSchema,
        "partially-bounded-admin": ScoreSchema,
        "concentrated-admin": ScoreSchema,
        "unbounded-reconciled": ScoreSchema,
        "unbounded-or-compromised": ScoreSchema,
        unknown: ScoreSchema,
      })
      .strict(),
    mintPostureGrading: z
      .object({
        prudentialReconciled: ScoreSchema,
        attestationOnlyReconciled: ScoreSchema,
      })
      .strict(),
    oracleTierQuality: z
      .object({
        "oracleless-or-internal": ScoreSchema,
        "redundant-with-failover": ScoreSchema,
        "medianized-with-delay": ScoreSchema,
        "standard-external": ScoreSchema,
        "single-source-or-laggy": ScoreSchema,
        "opaque-or-unknown": ScoreSchema,
      })
      .strict(),
    bridgeTierQuality: z
      .object({
        "single-chain-or-native": ScoreSchema,
        "issuer-native-burn-mint": ScoreSchema,
        "canonical-rollup-bridge": ScoreSchema,
        "issuer-native-lock-mint": ScoreSchema,
        "external-validated-network": ScoreSchema,
        "liquidity-or-intent-route": ScoreSchema,
        "external-lock-mint": ScoreSchema,
        "opaque-or-unknown": ScoreSchema,
      })
      .strict(),
    boundedUnknownQuality: ScoreSchema,
  })
  .strict();

const V9ExitPolicySchema = z
  .object({
    stressRequest: z
      .object({
        notionalGridUsd: z.array(z.number().finite().positive()).min(1),
        referenceNotionalUsd: z.number().finite().positive(),
        supplyRatio: z.number().finite().min(0).max(1),
        floorUsd: z.number().finite().positive(),
        capUsd: z.number().finite().positive(),
        maxCostBps: z.number().finite().nonnegative(),
        settlementHorizonSec: z.number().finite().positive(),
      })
      .strict(),
    componentWeights: z
      .object({
        access: z.number().finite().min(0).max(1),
        settlement: z.number().finite().min(0).max(1),
        executionCertainty: z.number().finite().min(0).max(1),
        capacity: z.number().finite().min(0).max(1),
        outputAssetQuality: z.number().finite().min(0).max(1),
        cost: z.number().finite().min(0).max(1),
      })
      .strict(),
    independentRouteBenefitLimit: z.number().finite().min(0).max(1),
    boundedUnknownScore: ScoreSchema,
    boundedCostScore: ScoreSchema,
    modeledConfidenceFactors: z
      .object({
        high: z.number().finite().min(0).max(1),
        medium: z.number().finite().min(0).max(1),
        low: z.number().finite().min(0).max(1),
      })
      .strict(),
    observationConfidenceFactors: z
      .object({
        high: z.number().finite().min(0).max(1),
        medium: z.number().finite().min(0).max(1),
        low: z.number().finite().min(0).max(1),
        unknown: z.number().finite().min(0).max(1),
      })
      .strict(),
    scoreableEvidenceKinds: z
      .object({ dex: z.array(z.string().min(1)).min(1), redemption: z.array(z.string().min(1)).min(1) })
      .strict(),
    strongEvidenceKinds: z.array(z.string().min(1)).min(1),
    documentedTermsMaxAgeSec: z.number().finite().positive(),
    ammModeledTvlRatio: z
      .object({ min: z.number().finite().nonnegative(), max: z.number().finite().positive() })
      .strict(),
    accessScores: z
      .object({
        "permissionless-onchain": ScoreSchema,
        "whitelisted-onchain": ScoreSchema,
        "issuer-api": ScoreSchema,
        manual: ScoreSchema,
      })
      .strict(),
    settlementScores: z
      .object({
        atomic: ScoreSchema,
        immediate: ScoreSchema,
        "same-day": ScoreSchema,
        days: ScoreSchema,
        queued: ScoreSchema,
      })
      .strict(),
    executionScores: z
      .object({
        "deterministic-onchain": ScoreSchema,
        "deterministic-basket": ScoreSchema,
        "rules-based-nav": ScoreSchema,
        opaque: ScoreSchema,
      })
      .strict(),
    outputAssetScores: z
      .object({
        "stable-single": ScoreSchema,
        "stable-basket": ScoreSchema,
        "bluechip-collateral": ScoreSchema,
        "mixed-collateral": ScoreSchema,
        nav: ScoreSchema,
      })
      .strict(),
    routeFamilyCaps: z.object({ queueRedeem: ScoreSchema, offchainIssuer: ScoreSchema }).strict(),
    coverageRatioBreakpoints: z.array(V9ScoreBreakpointSchema).min(2),
    absoluteCapacityBreakpoints: z.array(V9ScoreBreakpointSchema).min(2),
    settlementDelayBands: z
      .array(
        z
          .object({ maxSec: z.number().finite().positive().nullable(), multiplier: z.number().finite().min(0).max(1) })
          .strict(),
      )
      .min(1),
    queueBacklogBands: z.array(V9MultiplierBandSchema).min(1),
    minimumRedeemBands: z.array(V9MultiplierBandSchema).min(1),
    holderEligibilityMultipliers: z
      .object({
        "any-holder": z.number().finite().min(0).max(1),
        "verified-customer": z.number().finite().min(0).max(1),
        "whitelisted-primary": z.number().finite().min(0).max(1),
        "pre-incident-holder": z.number().finite().min(0).max(1),
        "issuer-discretionary": z.number().finite().min(0).max(1),
        unknown: z.number().finite().min(0).max(1),
      })
      .strict(),
  })
  .strict();

const V9MaterialityPolicySchema = z
  .object({
    serialRequiredPathsAlwaysBind: z.literal(true),
    basketExposureTreatment: z.literal("proportional"),
    deploymentMaterialSharePct: z.number().finite().min(0).max(100),
    commonModeOracleMinBranches: z.number().int().positive(),
    commonControlMinAssets: z.number().int().positive(),
    commonControlMinPaths: z.number().int().positive(),
    commonModeSignal: z.object({ kind: z.literal("critical-dependency"), severity: V9SeveritySchema }).strict(),
    // Reviewed mature chains whose shared common-mode concentration is
    // diagnostic rather than a coin-specific ceiling.
    matureChains: z.array(z.string().min(1)),
    // Proven exposure below this threshold is diagnostic. Exposure between this
    // threshold and commonModeHighShareThreshold is moderate.
    commonModeShareThreshold: z.number().finite().min(0).max(1),
    // Proven exposure at or above this threshold is high. Unknown or
    // unattributed exposure is also high regardless of its nominal bound.
    commonModeHighShareThreshold: z.number().finite().min(0).max(1).optional(),
    // Reviewed liquidity venues (dex-protocol common-mode) whose concentration is
    // not a capping signal. Non-mature venues use the proportional thresholds.
    matureVenues: z.array(z.string().min(1)),
    // Retained schema-v1 policies may carry the former bridge allowlist. It is
    // accepted only for replay compatibility and stripped before validation;
    // current materiality semantics never consult it.
    lowRiskBridgeTiers: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((materiality, ctx) => {
    if (
      materiality.commonModeHighShareThreshold !== undefined &&
      materiality.commonModeShareThreshold >= materiality.commonModeHighShareThreshold
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["commonModeHighShareThreshold"],
        message: "Common-mode high-share threshold must exceed the diagnostic-share threshold",
      });
    }
  })
  .transform(({ lowRiskBridgeTiers: _legacyBridgeTiers, ...materiality }) => ({
    ...materiality,
    commonModeHighShareThreshold: materiality.commonModeHighShareThreshold ?? materiality.commonModeShareThreshold,
  }));

const V9StructuralPolicySchema = z
  .object({
    signalLimits: V9StructuralSignalLimitMapSchema,
    commonModeOracleLimit: ScoreSchema,
    namedReasonCeilings: z
      .object({
        "control-unverified": ScoreSchema,
        "oracle-unverified": ScoreSchema,
        "backing-unverified": ScoreSchema,
        "exit-unverified": ScoreSchema,
        "peg-unverified": ScoreSchema,
      })
      .strict(),
  })
  .strict();

const V9HistoricalValidationPolicySchema = z
  .object({
    noRiskSignalScore: ScoreSchema,
    severityQuality: z
      .object({ low: ScoreSchema, moderate: ScoreSchema, high: ScoreSchema, critical: ScoreSchema })
      .strict(),
  })
  .strict();

const V9DecisionPolicySchema = z
  .object({
    formulaOrder: z.literal("quality-peg-caps"),
    parentPropagation: z.literal("required-parent-ceiling"),
    collateralUpstreamUnknown: z.literal("exposure-bounded-unless-serial-claim-unestablished"),
    dependencyScc: z.literal("member-and-descendant-treatment"),
    commonModeAggregation: z.literal("failure-domain"),
    implementationDateUnknown: z.literal("most-conservative-track-record-ceiling"),
    navAndPegReference: z.literal("nav-in-backing-peg-reference-in-peg"),
    frozenAssets: z.literal("archive-only-no-live-recompute"),
    historyTransition: z.literal("new-model-baseline"),
    accessPostureScoring: z.literal("categorical-unless-economic-loss-path"),
  })
  .strict();

export const V9MethodologySemanticSchema = z
  .object({
    formula: V9FormulaPolicySchema,
    evidence: V9EvidencePolicySchema,
    materiality: V9MaterialityPolicySchema,
    backing: V9BackingPolicySchema,
    exit: V9ExitPolicySchema,
    control: V9ControlPolicySchema,
    structural: V9StructuralPolicySchema,
    historicalValidation: V9HistoricalValidationPolicySchema,
    decisions: V9DecisionPolicySchema,
    accessPostureVocabulary: z
      .object({
        transfer: z.array(z.enum(["permissionless", "restrictable", "permissioned", "unknown"])).length(4),
        freezeExposure: z.array(z.enum(["none-known", "upstream", "direct", "possible", "unknown"])).length(5),
        primaryExit: z
          .array(z.enum(["permissionless", "eligibility-gated", "issuer-discretionary", "none", "unknown"]))
          .length(5),
        governance: z.array(z.enum(["immutable", "distributed", "concentrated", "single-entity", "unknown"])).length(5),
      })
      .strict(),
  })
  .strict();
export type V9MethodologySemantic = z.infer<typeof V9MethodologySemanticSchema>;

const V9_RATED_GRADES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;

const V9MethodologyPolicyBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyId: z.string().regex(/^safety-score-v9-[a-z0-9-]+$/),
    lifecycle: z.enum(["candidate", "active", "retired"]),
    releaseVersion: z
      .string()
      .regex(/^\d+\.\d+$/)
      .nullable(),
    semantic: V9MethodologySemanticSchema,
    reasonRegistry: z.array(V9ReasonRegistryEntrySchema),
  })
  .strict();

function addPolicyIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function validateAscendingBreakpoints(
  values: readonly { value: number; score: number }[],
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]!.value <= values[index - 1]!.value) {
      addPolicyIssue(ctx, [...path, index, "value"], "Breakpoint values must be strictly increasing");
    }
    if (values[index]!.score < values[index - 1]!.score) {
      addPolicyIssue(ctx, [...path, index, "score"], "Breakpoint scores cannot decrease");
    }
  }
}

export const V9MethodologyPolicySchema = V9MethodologyPolicyBaseSchema.superRefine((policy, ctx) => {
  if (policy.lifecycle === "candidate" && policy.releaseVersion !== null) {
    addPolicyIssue(ctx, ["releaseVersion"], "Candidate policy cannot claim a release version");
  }
  if (policy.lifecycle !== "candidate" && policy.releaseVersion === null) {
    addPolicyIssue(ctx, ["releaseVersion"], "Active or retired policy requires a release version");
  }

  const formula = policy.semantic.formula;
  const weightTotal = Object.values(formula.pillarWeights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(weightTotal - 1) > 1e-9) {
    addPolicyIssue(
      ctx,
      ["semantic", "formula", "pillarWeights"],
      `Pillar weights must sum to 1; received ${weightTotal}`,
    );
  }
  const componentWeightTotal = Object.values(policy.semantic.exit.componentWeights).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (Math.abs(componentWeightTotal - 1) > 1e-9) {
    addPolicyIssue(
      ctx,
      ["semantic", "exit", "componentWeights"],
      `Exit component weights must sum to 1; received ${componentWeightTotal}`,
    );
  }

  const priority = formula.capTiePriority;
  if (
    priority.length !== V9CapSourceSchema.options.length ||
    new Set(priority).size !== V9CapSourceSchema.options.length
  ) {
    addPolicyIssue(
      ctx,
      ["semantic", "formula", "capTiePriority"],
      "Cap tie priority must contain every cap source exactly once",
    );
  }

  const grades = formula.gradeThresholds;
  if (
    grades.length !== V9_RATED_GRADES.length ||
    grades.some((entry, index) => entry.grade !== V9_RATED_GRADES[index])
  ) {
    addPolicyIssue(
      ctx,
      ["semantic", "formula", "gradeThresholds"],
      "Grade thresholds must contain every rated grade once in descending order",
    );
  }
  grades.forEach((entry, index) => {
    if (index > 0 && entry.minScore >= grades[index - 1]!.minScore) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "gradeThresholds", index, "minScore"],
        "Grade thresholds must strictly decrease",
      );
    }
  });
  if (grades[grades.length - 1]?.minScore !== 0) {
    addPolicyIssue(ctx, ["semantic", "formula", "gradeThresholds"], "F threshold must begin at zero");
  }

  const trackBands = formula.trackRecordCeilings;
  if (trackBands[0]?.minMonthsInclusive !== 0) {
    addPolicyIssue(ctx, ["semantic", "formula", "trackRecordCeilings", 0], "Track-record bands must start at zero");
  }
  trackBands.forEach((band, index) => {
    const next = trackBands[index + 1];
    if (next && band.maxMonthsExclusive !== next.minMonthsInclusive) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "trackRecordCeilings", index, "maxMonthsExclusive"],
        "Track-record bands must be contiguous and non-overlapping",
      );
    }
    if (!next && band.maxMonthsExclusive !== null) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "trackRecordCeilings", index, "maxMonthsExclusive"],
        "Final track-record band must be open-ended",
      );
    }
    if (band.maxMonthsExclusive !== null && band.maxMonthsExclusive <= band.minMonthsInclusive) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "trackRecordCeilings", index],
        "Track-record band must have positive width",
      );
    }
  });

  formula.activeDepegCaps.forEach((cap, index) => {
    const previous = formula.activeDepegCaps[index - 1];
    if (previous && cap.minimumBps >= previous.minimumBps) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "activeDepegCaps", index, "minimumBps"],
        "Active-depeg thresholds must strictly decrease",
      );
    }
    if (previous && cap.limit < previous.limit) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "activeDepegCaps", index, "limit"],
        "Lower-severity active-depeg bands cannot impose a tighter limit",
      );
    }
    const declaredGrade = V9_RATED_GRADES.find((grade) => cap.kind === `active-depeg:${grade.toLowerCase()}`);
    const resolvedGrade = grades.find((threshold) => cap.limit >= threshold.minScore)?.grade ?? "F";
    if (declaredGrade !== undefined && resolvedGrade !== declaredGrade) {
      addPolicyIssue(
        ctx,
        ["semantic", "formula", "activeDepegCaps", index, "limit"],
        `Active-depeg cap ${cap.kind} must remain inside its declared ${declaredGrade} grade band`,
      );
    }
  });

  const dispositionClasses = policy.semantic.evidence.dispositions.map((entry) => entry.factClass);
  if (
    dispositionClasses.length !== V9FactClassSchema.options.length ||
    new Set(dispositionClasses).size !== V9FactClassSchema.options.length ||
    V9FactClassSchema.options.some((factClass) => !dispositionClasses.includes(factClass))
  ) {
    addPolicyIssue(
      ctx,
      ["semantic", "evidence", "dispositions"],
      "Evidence dispositions must cover every fact class exactly once",
    );
  }
  const ranks = Object.values(policy.semantic.evidence.rank);
  if (new Set(ranks).size !== ranks.length || Math.min(...ranks) !== 0 || Math.max(...ranks) !== ranks.length - 1) {
    addPolicyIssue(ctx, ["semantic", "evidence", "rank"], "Evidence ranks must be a complete zero-based ordering");
  }

  const reasonCodes = policy.reasonRegistry.map((entry) => entry.code);
  if (
    reasonCodes.length !== V9_REASON_CODES.length ||
    new Set(reasonCodes).size !== V9_REASON_CODES.length ||
    V9_REASON_CODES.some((code) => !reasonCodes.includes(code))
  ) {
    addPolicyIssue(ctx, ["reasonRegistry"], "Reason registry must cover every V9 reason code exactly once");
  }
  const dispositionsByClass = new Map(
    policy.semantic.evidence.dispositions.map((disposition) => [disposition.factClass, disposition]),
  );
  policy.reasonRegistry.forEach((entry, index) => {
    const disposition = dispositionsByClass.get(entry.defaultFactClass);
    if (!disposition) return;
    if ((entry.defaultTreatment === "NR") !== (disposition.rateability === "NR")) {
      addPolicyIssue(
        ctx,
        ["reasonRegistry", index, "defaultTreatment"],
        "NR treatment and disposition rateability must agree",
      );
    }
    if (entry.ceilingRule?.source === "evidence-level") {
      const limit = policy.semantic.evidence.ceilings[entry.ceilingRule.level];
      if (limit === null) {
        addPolicyIssue(
          ctx,
          ["reasonRegistry", index, "ceilingRule"],
          `Reason ceiling references ${entry.ceilingRule.level} evidence, which has no ceiling`,
        );
      }
    }
    if (entry.ceilingRule?.source === "minimum-track-record") {
      const minimumBand = [...policy.semantic.formula.trackRecordCeilings].sort(
        (left, right) => left.minMonthsInclusive - right.minMonthsInclusive,
      )[0];
      if (!minimumBand || minimumBand.limit === null) {
        addPolicyIssue(
          ctx,
          ["reasonRegistry", index, "ceilingRule"],
          "Minimum track-record reason ceiling requires a finite lowest-band limit",
        );
      }
    }
  });

  const backing = policy.semantic.backing;
  const reserveFactorWeight = Object.values(backing.reserve.factorWeights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(reserveFactorWeight - 1) > 1e-9) {
    addPolicyIssue(
      ctx,
      ["semantic", "backing", "reserve", "factorWeights"],
      `Backing reserve factor weights must sum to 1; received ${reserveFactorWeight}`,
    );
  }
  if (
    new Set(backing.reserve.maturityNotApplicableClasses).size !== backing.reserve.maturityNotApplicableClasses.length
  ) {
    addPolicyIssue(
      ctx,
      ["semantic", "backing", "reserve", "maturityNotApplicableClasses"],
      "Maturity not-applicable classes must be unique",
    );
  }
  const openMaturityBands = backing.reserve.maturityBands.filter((band) => band.maxDaysInclusive === null);
  const finiteMaturityBands = backing.reserve.maturityBands.filter(
    (band): band is { maxDaysInclusive: number; score: number } => band.maxDaysInclusive !== null,
  );
  if (openMaturityBands.length !== 1) {
    addPolicyIssue(
      ctx,
      ["semantic", "backing", "reserve", "maturityBands"],
      "Backing maturity bands require exactly one open-ended band",
    );
  }
  finiteMaturityBands.forEach((band, index) => {
    if (index > 0 && band.maxDaysInclusive <= finiteMaturityBands[index - 1]!.maxDaysInclusive) {
      addPolicyIssue(
        ctx,
        ["semantic", "backing", "reserve", "maturityBands", index, "maxDaysInclusive"],
        "Backing maturity bands must be strictly increasing before the open-ended band",
      );
    }
  });
  const concentrationThresholds = backing.reserve.concentrationBands.map((band) => band.minShareInclusive);
  if (
    concentrationThresholds[0] !== 0 ||
    new Set(concentrationThresholds).size !== concentrationThresholds.length ||
    concentrationThresholds.some((threshold, index) => index > 0 && threshold <= concentrationThresholds[index - 1]!)
  ) {
    addPolicyIssue(
      ctx,
      ["semantic", "backing", "reserve", "concentrationBands"],
      "Backing concentration bands must start at zero and strictly increase",
    );
  }
  const severityShares = backing.structural.severityShares;
  if (!(severityShares.moderate < severityShares.high && severityShares.high < severityShares.critical)) {
    addPolicyIssue(
      ctx,
      ["semantic", "backing", "structural", "severityShares"],
      "Backing severity shares must strictly increase",
    );
  }
  Object.entries(backing.archetypes).forEach(([archetype, archetypePolicy]) => {
    const componentWeight = Object.values(archetypePolicy.componentWeights).reduce((sum, value) => sum + value, 0);
    if (Math.abs(archetypePolicy.reserveWeight + componentWeight - 1) > 1e-9) {
      addPolicyIssue(
        ctx,
        ["semantic", "backing", "archetypes", archetype, "componentWeights"],
        `${archetype} backing weights must sum to 1`,
      );
    }
    if (
      new Set(archetypePolicy.serialComponentKeys).size !== archetypePolicy.serialComponentKeys.length ||
      archetypePolicy.serialComponentKeys.some((key) => !(key in archetypePolicy.componentWeights))
    ) {
      addPolicyIssue(
        ctx,
        ["semantic", "backing", "archetypes", archetype, "serialComponentKeys"],
        `${archetype} serial components must be unique weighted components`,
      );
    }
    if (Object.keys(archetypePolicy.structuralComponents).some((key) => !(key in archetypePolicy.componentWeights))) {
      addPolicyIssue(
        ctx,
        ["semantic", "backing", "archetypes", archetype, "structuralComponents"],
        `${archetype} structural components must be weighted components`,
      );
    }
  });
  const backingSignals = [
    backing.structural.unsafeExposureSignal,
    backing.structural.speculativeCreditSignal,
    backing.structural.commonModeSignal,
    backing.structural.nonSubstitutableFailureSignal,
    backing.structural.algorithmic.signal,
    backing.structural.cdp.collateralizationSignal,
    backing.structural.cdp.liquidationSignal,
    backing.structural.synthetic.hedgeSignal,
    backing.structural.synthetic.lossAbsorptionSignal,
    backing.structural.rwaCreditFund.signal,
    ...Object.values(backing.archetypes).flatMap((archetype) => Object.values(archetype.structuralComponents)),
  ];
  backingSignals.forEach((signal, index) => {
    if (policy.semantic.structural.signalLimits[signal.kind][signal.severity] === null) {
      addPolicyIssue(
        ctx,
        ["semantic", "backing", "structural", "signals", index],
        `Backing signal ${signal.kind}:${signal.severity} requires a finite central structural limit`,
      );
    }
  });

  const stress = policy.semantic.exit.stressRequest;
  if (!(stress.floorUsd <= stress.referenceNotionalUsd && stress.referenceNotionalUsd <= stress.capUsd)) {
    addPolicyIssue(
      ctx,
      ["semantic", "exit", "stressRequest"],
      "Exit reference notional must fall between the floor and cap",
    );
  }
  if (!stress.notionalGridUsd.includes(stress.referenceNotionalUsd)) {
    addPolicyIssue(
      ctx,
      ["semantic", "exit", "stressRequest", "notionalGridUsd"],
      "Exit notional grid must contain the reference notional",
    );
  }
  stress.notionalGridUsd.forEach((value, index) => {
    if (index > 0 && value <= stress.notionalGridUsd[index - 1]!) {
      addPolicyIssue(
        ctx,
        ["semantic", "exit", "stressRequest", "notionalGridUsd", index],
        "Exit notionals must be strictly increasing",
      );
    }
  });
  if (policy.semantic.exit.ammModeledTvlRatio.min > policy.semantic.exit.ammModeledTvlRatio.max) {
    addPolicyIssue(ctx, ["semantic", "exit", "ammModeledTvlRatio"], "AMM TVL ratio bounds are reversed");
  }
  validateAscendingBreakpoints(policy.semantic.exit.coverageRatioBreakpoints, ctx, [
    "semantic",
    "exit",
    "coverageRatioBreakpoints",
  ]);
  validateAscendingBreakpoints(policy.semantic.exit.absoluteCapacityBreakpoints, ctx, [
    "semantic",
    "exit",
    "absoluteCapacityBreakpoints",
  ]);

  const settlementBands = policy.semantic.exit.settlementDelayBands;
  settlementBands.forEach((band, index) => {
    const previous = settlementBands[index - 1];
    if (index < settlementBands.length - 1 && band.maxSec === null) {
      addPolicyIssue(
        ctx,
        ["semantic", "exit", "settlementDelayBands", index],
        "Only the last settlement band may be open-ended",
      );
    }
    if (index === settlementBands.length - 1 && band.maxSec !== null) {
      addPolicyIssue(
        ctx,
        ["semantic", "exit", "settlementDelayBands", index],
        "Final settlement band must be open-ended",
      );
    }
    if (previous?.maxSec != null && band.maxSec != null && band.maxSec <= previous.maxSec) {
      addPolicyIssue(ctx, ["semantic", "exit", "settlementDelayBands", index], "Settlement bands must increase");
    }
  });

  for (const [field, bands] of [
    ["queueBacklogBands", policy.semantic.exit.queueBacklogBands],
    ["minimumRedeemBands", policy.semantic.exit.minimumRedeemBands],
  ] as const) {
    bands.forEach((band, index) => {
      const previous = bands[index - 1];
      if (previous && band.threshold >= previous.threshold) {
        addPolicyIssue(ctx, ["semantic", "exit", field, index, "threshold"], `${field} thresholds must decrease`);
      }
      if (previous && band.multiplier < previous.multiplier) {
        addPolicyIssue(ctx, ["semantic", "exit", field, index, "multiplier"], `${field} multipliers cannot decrease`);
      }
    });
  }
});
export type V9MethodologyPolicy = z.infer<typeof V9MethodologyPolicySchema>;

export const V9MethodologySemanticPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    semantic: V9MethodologySemanticSchema,
    reasonRegistry: z.array(V9ReasonRegistryEntrySchema),
  })
  .strict();
export type V9MethodologySemanticPayload = z.infer<typeof V9MethodologySemanticPayloadSchema>;

export interface V9ValidatedPolicyEnvelope {
  readonly policy: V9MethodologyPolicy;
  readonly semanticDigest: string;
}
