import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import historicalFixtureAsset from "../../shared/data/safety-score-v9/historical-fixtures-v1.json";
import { sha256Hex } from "../../shared/lib/sha256";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";
import { verifyV9ReleaseCandidateSealDigest } from "../../shared/lib/safety-score-v9/validation";
import {
  HistoricalV9FixtureCorpusSchema,
  type HistoricalV9FixtureCorpus,
} from "../../shared/types/safety-score-v9";
import {
  V9ReleaseCandidateSealSchema,
  type V9ReleaseCandidateSeal,
} from "../../shared/types/safety-score-v9-validation";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const PortableArtifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !isAbsolute(path) && !path.split(/[\\/]+/u).includes(".."),
    "Artifact paths must be portable paths beneath their manifest directory",
  );

const ArtifactRefSchema = z
  .object({
    path: PortableArtifactPathSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type V9HoldoutArtifactRef = z.infer<typeof ArtifactRefSchema>;

const SourceArchiveEntrySchema = z
  .object({
    sourceId: IdentifierSchema,
    title: z.string().min(1),
    originalUrl: z.string().url(),
    publishedAt: IsoTimestampSchema,
    supports: z.array(z.string().min(1)).min(1),
    availabilityProof: z
      .object({
        kind: z.enum(["third-party-snapshot", "content-addressed-publication", "immutable-publisher-record"]),
        url: z.string().url(),
        observedAt: IsoTimestampSchema,
        verifiedBy: z.array(IdentifierSchema).min(1),
      })
      .strict(),
    archiveArtifact: ArtifactRefSchema,
  })
  .strict();
export type V9HoldoutSourceArchiveEntry = z.infer<typeof SourceArchiveEntrySchema>;

const SourceArchiveCaseSchema = z
  .object({
    caseId: IdentifierSchema,
    evidenceCutoff: IsoTimestampSchema,
    exactProductionInputArtifact: ArtifactRefSchema,
    compiledFactArtifact: ArtifactRefSchema,
    sources: z.array(SourceArchiveEntrySchema).min(1),
  })
  .strict();

export const V9HoldoutSourceArchiveManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    holdoutId: IdentifierSchema,
    createdAt: IsoTimestampSchema,
    createdBy: IdentifierSchema,
    split: z
      .object({
        selectedAt: IsoTimestampSchema,
        selectedBy: IdentifierSchema,
        calibrationCaseIds: z.array(IdentifierSchema).min(1),
        holdoutCaseIds: z.array(IdentifierSchema).min(24),
        v8OutputAccessAtSelection: z.literal("withheld"),
        v9OutputAccessAtSelection: z.literal("withheld"),
        preregistrationArtifact: ArtifactRefSchema,
      })
      .strict(),
    productionCompilation: z
      .object({
        entrypoint: z.literal(
          "worker/src/lib/safety-score-v9-fact-set.ts#compileSafetyScoreV9FactSetFromFixedInput",
        ),
        factSetDigest: Sha256Schema,
        evaluationBuildDigest: Sha256Schema,
        compilerFactSchemaDigest: Sha256Schema,
        producerCapabilityDigest: Sha256Schema,
        auditStatus: z.literal("passed"),
        auditedBy: z.array(IdentifierSchema).min(1),
      })
      .strict(),
    cases: z.array(SourceArchiveCaseSchema).min(24),
  })
  .strict();
export type V9HoldoutSourceArchiveManifest = z.infer<typeof V9HoldoutSourceArchiveManifestSchema>;

const BlindReviewEntrySchema = z
  .object({
    reviewId: IdentifierSchema,
    reviewerId: IdentifierSchema,
    mode: z.enum(["semantic-grade", "pairwise-order"]),
    caseIds: z.array(IdentifierSchema).min(1),
    reviewedAt: IsoTimestampSchema,
    v8OutputAccess: z.literal("withheld"),
    v9OutputAccess: z.literal("withheld"),
    independenceAttestation: z.string().min(20),
    judgmentArtifact: ArtifactRefSchema,
  })
  .strict();

export const V9HoldoutBlindReviewManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    holdoutId: IdentifierSchema,
    createdAt: IsoTimestampSchema,
    reviewers: z.array(IdentifierSchema).min(2),
    reviews: z.array(BlindReviewEntrySchema).min(2),
    disagreementCaseIds: z.array(IdentifierSchema),
    adjudications: z.array(
      z
        .object({
          adjudicationId: IdentifierSchema,
          caseIds: z.array(IdentifierSchema).min(1),
          adjudicatorId: IdentifierSchema,
          basis: z.literal("safety-semantics-not-distribution-shape"),
          adjudicatedAt: IsoTimestampSchema,
          artifact: ArtifactRefSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type V9HoldoutBlindReviewManifest = z.infer<typeof V9HoldoutBlindReviewManifestSchema>;

const SOURCE_CASE_DIGEST_DOMAIN = "safety-score-v9.holdout-case-source-archive.v1";
const SOURCE_ARCHIVE_DIGEST_DOMAIN = "safety-score-v9.holdout-source-archive.v1";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...values].sort(compareText);
}

export function computeV9HoldoutCaseSourceDigest(sources: readonly V9HoldoutSourceArchiveEntry[]): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: SOURCE_CASE_DIGEST_DOMAIN,
      sources: [...sources].sort((left, right) => compareText(left.sourceId, right.sourceId)),
    }),
  );
}

export function computeV9HoldoutSourceArchiveDigest(rawManifest: unknown): string {
  const manifest = V9HoldoutSourceArchiveManifestSchema.parse(rawManifest);
  return sha256Hex(
    stableJsonStringifyV1({
      domain: SOURCE_ARCHIVE_DIGEST_DOMAIN,
      manifest,
    }),
  );
}

export interface ArtifactInspection {
  exists: boolean;
  sha256: string | null;
  error: string | null;
}

export interface V9HoldoutStatusCheck {
  code: string;
  status: "passed" | "failed" | "not-run";
  detail: string;
}

export interface V9HoldoutStatusReport {
  schemaVersion: 1;
  generatedAt: string;
  purpose: "gate-3-preparation-status-not-holdout-result";
  decision: "blocked" | "preparation-ready";
  releaseClaim: "not-a-gate-3-pass";
  legacyCorpus: {
    role: "protocol-regression-only";
    schemaValid: boolean;
    fixtureCount: number;
    adverseCount: number;
    resilientCount: number;
    sourceCount: number;
    captureStatuses: Record<string, number>;
    blindingModes: Record<string, number>;
    outcomeAccess: Record<string, number>;
    sameFactAndOutcomeReviewerCount: number;
    chronologyStatus: "passed" | "invalid";
    immutableSourceStatus: "passed" | "blocked" | "invalid";
    independentBlindingStatus: "passed" | "blocked" | "invalid";
    admissibleAsReleaseHoldout: false;
    limitations: string[];
  };
  protocolImplementation: {
    validatorPath: string;
    syntheticExercisePath: string;
    syntheticExerciseAdmissibleAsReleaseEvidence: false;
    validatorCanEvaluateBoundReleaseArtifacts: true;
    preparationAddsTwoReviewerFloor: true;
    note: string;
  };
  suppliedArtifacts: {
    seal: "not-supplied" | "valid" | "invalid";
    sourceArchiveManifest: "not-supplied" | "valid" | "invalid";
    blindReviewManifest: "not-supplied" | "valid" | "invalid";
  };
  checks: V9HoldoutStatusCheck[];
  blockers: Array<{ code: string; owner: string; requirement: string }>;
  externalPrerequisites: Array<{ owner: string; requirement: string; machineVerifiablePart: string }>;
  limitations: string[];
}

export interface BuildV9HoldoutStatusInput {
  generatedAt: string;
  historicalCorpus?: unknown;
  seal?: unknown;
  sealLoadError?: string | null;
  sourceArchiveManifest?: unknown;
  sourceArchiveManifestLoadError?: string | null;
  sourceArchiveBaseDir?: string;
  blindReviewManifest?: unknown;
  blindReviewManifestLoadError?: string | null;
  blindReviewBaseDir?: string;
  inspectArtifact?: (absolutePath: string) => ArtifactInspection;
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function summarizeLegacyCorpus(rawCorpus: unknown): V9HoldoutStatusReport["legacyCorpus"] {
  const parsed = HistoricalV9FixtureCorpusSchema.safeParse(rawCorpus);
  if (!parsed.success) {
    return {
      role: "protocol-regression-only",
      schemaValid: false,
      fixtureCount: 0,
      adverseCount: 0,
      resilientCount: 0,
      sourceCount: 0,
      captureStatuses: {},
      blindingModes: {},
      outcomeAccess: {},
      sameFactAndOutcomeReviewerCount: 0,
      chronologyStatus: "invalid",
      immutableSourceStatus: "invalid",
      independentBlindingStatus: "invalid",
      admissibleAsReleaseHoldout: false,
      limitations: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
    };
  }

  const corpus: HistoricalV9FixtureCorpus = parsed.data;
  const sources = corpus.fixtures.flatMap((fixture) => fixture.sources);
  const unarchived = sources.filter((source) => source.capture.status === "unarchived").length;
  const unblinded = corpus.fixtures.filter(
    (fixture) =>
      fixture.blinding.mode !== "independent-reviewers" || fixture.factFreeze.outcomeAccess !== "withheld",
  ).length;
  const sameReviewerCount = corpus.fixtures.filter(
    (fixture) => fixture.factFreeze.reviewer === fixture.outcomeAnnotation.reviewer,
  ).length;
  return {
    role: "protocol-regression-only",
    schemaValid: true,
    fixtureCount: corpus.fixtures.length,
    adverseCount: corpus.fixtures.filter((fixture) => fixture.outcome.classification === "adverse").length,
    resilientCount: corpus.fixtures.filter((fixture) => fixture.outcome.classification === "resilient").length,
    sourceCount: sources.length,
    captureStatuses: countBy(sources.map((source) => source.capture.status)),
    blindingModes: countBy(corpus.fixtures.map((fixture) => fixture.blinding.mode)),
    outcomeAccess: countBy(corpus.fixtures.map((fixture) => fixture.factFreeze.outcomeAccess)),
    sameFactAndOutcomeReviewerCount: sameReviewerCount,
    chronologyStatus: "passed",
    immutableSourceStatus: unarchived === 0 ? "passed" : "blocked",
    independentBlindingStatus: unblinded === 0 && sameReviewerCount === 0 ? "passed" : "blocked",
    admissibleAsReleaseHoldout: false,
    limitations: [
      ...(unarchived > 0 ? [`${unarchived} source records have no immutable local capture or archive binding.`] : []),
      ...(unblinded > 0 ? [`${unblinded} fixtures lack independently verified blinded fact authoring.`] : []),
      ...(sameReviewerCount > 0
        ? [`${sameReviewerCount} fixtures name the same fact and outcome reviewer.`]
        : []),
      "The fixtures use a retrospective research compiler boundary, not archived full production fact-set generations.",
      "Chronology validation proves declared source dates only; it does not prove the cited bytes existed unchanged at the cutoff.",
    ],
  };
}

function defaultInspectArtifact(absolutePath: string): ArtifactInspection {
  try {
    const bytes = readFileSync(absolutePath);
    return {
      exists: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exists: false, sha256: null, error: message };
  }
}

function inspectArtifactRefs(
  refs: readonly V9HoldoutArtifactRef[],
  baseDir: string,
  inspectArtifact: (absolutePath: string) => ArtifactInspection,
): { valid: boolean; detail: string } {
  const failures: string[] = [];
  for (const ref of refs) {
    const inspected = inspectArtifact(resolve(baseDir, ref.path));
    if (!inspected.exists) {
      failures.push(`${ref.path}: missing${inspected.error ? ` (${inspected.error})` : ""}`);
    } else if (inspected.sha256 !== ref.sha256) {
      failures.push(`${ref.path}: SHA-256 mismatch`);
    }
  }
  return {
    valid: failures.length === 0,
    detail: failures.length === 0 ? `${refs.length} referenced artifact(s) match their SHA-256 digests.` : failures.join("; "),
  };
}

function addCheck(
  checks: V9HoldoutStatusCheck[],
  code: string,
  status: V9HoldoutStatusCheck["status"],
  detail: string,
): void {
  checks.push({ code, status, detail });
}

function uniqueCanonical(values: readonly string[]): boolean {
  return new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function checkSeal(seal: V9ReleaseCandidateSeal, checks: V9HoldoutStatusCheck[]): void {
  addCheck(
    checks,
    "seal-digest",
    verifyV9ReleaseCandidateSealDigest(seal) ? "passed" : "failed",
    "Release-candidate seal digest must match its canonical payload.",
  );
  addCheck(
    checks,
    "holdout-case-floor",
    seal.cases.length >= seal.thresholds.minimumCaseCount ? "passed" : "failed",
    `${seal.cases.length} sealed holdout case(s); minimum is ${seal.thresholds.minimumCaseCount}.`,
  );
  const pairArchetypes = new Set(seal.matchedPairs.map((pair) => pair.archetype)).size;
  const pairFailureFamilies = new Set(seal.matchedPairs.map((pair) => pair.failurePathFamily)).size;
  addCheck(
    checks,
    "matched-pair-coverage",
    seal.matchedPairs.length >= seal.thresholds.minimumMatchedPairCount &&
      pairArchetypes >= seal.thresholds.minimumMatchedPairArchetypeCount &&
      pairFailureFamilies >= seal.thresholds.minimumMatchedPairFailurePathFamilyCount
      ? "passed"
      : "failed",
    `${seal.matchedPairs.length} pair(s), ${pairArchetypes} archetype(s), ${pairFailureFamilies} failure-path family/families.`,
  );
  const failedPrerequisites = Object.entries(seal.prerequisites)
    .filter(([, status]) => status !== "passed")
    .map(([name, status]) => `${name}=${status}`);
  addCheck(
    checks,
    "sealed-prerequisites",
    failedPrerequisites.length === 0 ? "passed" : "failed",
    failedPrerequisites.length === 0
      ? "All four seal prerequisites are recorded as passed."
      : `Incomplete seal prerequisites: ${failedPrerequisites.join(", ")}.`,
  );
}

function checkSourceArchive(args: {
  seal: V9ReleaseCandidateSeal;
  manifest: V9HoldoutSourceArchiveManifest;
  baseDir: string;
  inspectArtifact: (absolutePath: string) => ArtifactInspection;
  checks: V9HoldoutStatusCheck[];
}): void {
  const { seal, manifest, checks } = args;
  const sealedCaseIds = canonicalStrings(seal.cases.map((entry) => entry.caseId));
  const archiveCaseIds = canonicalStrings(manifest.cases.map((entry) => entry.caseId));
  const splitHoldoutIds = canonicalStrings(manifest.split.holdoutCaseIds);
  const calibrationIds = new Set(manifest.split.calibrationCaseIds);
  const splitDisjoint = manifest.split.holdoutCaseIds.every((caseId) => !calibrationIds.has(caseId));
  addCheck(
    checks,
    "archive-identity-and-split",
    manifest.holdoutId === seal.holdoutId &&
      uniqueCanonical(manifest.split.calibrationCaseIds) &&
      uniqueCanonical(manifest.split.holdoutCaseIds) &&
      splitDisjoint &&
      stableJsonStringifyV1(archiveCaseIds) === stableJsonStringifyV1(sealedCaseIds) &&
      stableJsonStringifyV1(splitHoldoutIds) === stableJsonStringifyV1(sealedCaseIds)
      ? "passed"
      : "failed",
    "Archive identity must match the seal, and the preregistered calibration/holdout split must be canonical, disjoint, and complete.",
  );
  addCheck(
    checks,
    "split-timing-and-preregistration",
    Date.parse(manifest.split.selectedAt) <= Date.parse(manifest.createdAt) &&
      Date.parse(manifest.createdAt) <= Date.parse(seal.sealedAt) &&
      manifest.split.selectedBy === seal.reviewers.selectionOwnerId &&
      manifest.split.preregistrationArtifact.sha256 === seal.digests.preregistrationDigest
      ? "passed"
      : "failed",
    "The selection owner must preregister the split before archive creation and candidate sealing.",
  );
  addCheck(
    checks,
    "production-compilation-binding",
    manifest.productionCompilation.factSetDigest === seal.digests.factSetDigest &&
      manifest.productionCompilation.evaluationBuildDigest === seal.digests.evaluationBuildDigest
      ? "passed"
      : "failed",
    "The archived production fact set and evaluator build must match the sealed candidate.",
  );

  const sealedById = new Map(seal.cases.map((entry) => [entry.caseId, entry]));
  const caseBindingFailures: string[] = [];
  const sourceChronologyFailures: string[] = [];
  const duplicateSourceIds: string[] = [];
  for (const entry of manifest.cases) {
    const sealed = sealedById.get(entry.caseId);
    if (
      !sealed ||
      entry.evidenceCutoff !== sealed.evidenceCutoff ||
      entry.compiledFactArtifact.sha256 !== sealed.factDigest ||
      computeV9HoldoutCaseSourceDigest(entry.sources) !== sealed.sourceDigest
    ) {
      caseBindingFailures.push(entry.caseId);
    }
    const sourceIds = entry.sources.map((source) => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) duplicateSourceIds.push(entry.caseId);
    for (const source of entry.sources) {
      if (
        Date.parse(source.publishedAt) > Date.parse(entry.evidenceCutoff) ||
        Date.parse(source.availabilityProof.observedAt) > Date.parse(entry.evidenceCutoff)
      ) {
        sourceChronologyFailures.push(`${entry.caseId}:${source.sourceId}`);
      }
    }
  }
  addCheck(
    checks,
    "case-fact-and-source-bindings",
    caseBindingFailures.length === 0 ? "passed" : "failed",
    caseBindingFailures.length === 0
      ? "Every case cutoff, compiled-fact digest, and canonical source digest matches the seal."
      : `Case binding failures: ${canonicalStrings(caseBindingFailures).join(", ")}.`,
  );
  addCheck(
    checks,
    "point-in-time-source-proof",
    sourceChronologyFailures.length === 0 && duplicateSourceIds.length === 0 ? "passed" : "failed",
    sourceChronologyFailures.length === 0 && duplicateSourceIds.length === 0
      ? "Every source publication and availability proof is at or before its evidence cutoff."
      : `Source chronology failures: ${canonicalStrings(sourceChronologyFailures).join(", ") || "none"}; duplicate source IDs in: ${canonicalStrings(duplicateSourceIds).join(", ") || "none"}.`,
  );

  const artifactRefs = [
    manifest.split.preregistrationArtifact,
    ...manifest.cases.flatMap((entry) => [
      entry.exactProductionInputArtifact,
      entry.compiledFactArtifact,
      ...entry.sources.map((source) => source.archiveArtifact),
    ]),
  ];
  const artifactInspection = inspectArtifactRefs(artifactRefs, args.baseDir, args.inspectArtifact);
  addCheck(
    checks,
    "archive-file-integrity",
    artifactInspection.valid ? "passed" : "failed",
    artifactInspection.detail,
  );
  addCheck(
    checks,
    "source-archive-digest",
    computeV9HoldoutSourceArchiveDigest(manifest) === seal.digests.sourceArchiveDigest ? "passed" : "failed",
    "The canonical source-archive manifest digest must match the release-candidate seal.",
  );
}

function checkBlindReviews(args: {
  seal: V9ReleaseCandidateSeal;
  manifest: V9HoldoutBlindReviewManifest;
  baseDir: string;
  inspectArtifact: (absolutePath: string) => ArtifactInspection;
  checks: V9HoldoutStatusCheck[];
}): void {
  const { seal, manifest, checks } = args;
  const registered = new Set(seal.reviewers.outcomeReviewerIds);
  const factReviewers = new Set(seal.cases.flatMap((entry) => entry.factReviewerIds));
  const prohibited = new Set([
    seal.reviewers.selectionOwnerId,
    ...seal.reviewers.calibrationOwnerIds,
    ...factReviewers,
  ]);
  const reviewerIds = canonicalStrings(manifest.reviewers);
  const reviewerSetValid =
    manifest.holdoutId === seal.holdoutId &&
    uniqueCanonical(manifest.reviewers) &&
    reviewerIds.length >= 2 &&
    reviewerIds.every((reviewerId) => registered.has(reviewerId) && !prohibited.has(reviewerId));
  addCheck(
    checks,
    "blind-reviewer-independence",
    reviewerSetValid ? "passed" : "failed",
    `${reviewerIds.length} blinded safety reviewer(s) supplied; at least two must be registered and independent of selection, calibration, and fact review.`,
  );

  const sealedCaseIds = new Set(seal.cases.map((entry) => entry.caseId));
  const coverage = new Map<string, Set<string>>(seal.cases.map((entry) => [entry.caseId, new Set()]));
  let invalidReview = false;
  for (const review of manifest.reviews) {
    if (
      !reviewerIds.includes(review.reviewerId) ||
      !uniqueCanonical(review.caseIds) ||
      Date.parse(review.reviewedAt) > Date.parse(seal.sealedAt)
    ) {
      invalidReview = true;
    }
    for (const caseId of review.caseIds) {
      if (!sealedCaseIds.has(caseId)) {
        invalidReview = true;
      } else {
        coverage.get(caseId)!.add(review.reviewerId);
      }
    }
  }
  const underReviewed = [...coverage]
    .filter(([, reviewers]) => reviewers.size < 2)
    .map(([caseId]) => caseId);
  addCheck(
    checks,
    "two-blind-reviews-per-case",
    !invalidReview && underReviewed.length === 0 ? "passed" : "failed",
    underReviewed.length === 0 && !invalidReview
      ? "Every sealed holdout case has judgments from at least two distinct reviewers, recorded before sealing."
      : `Cases below two valid reviews: ${canonicalStrings(underReviewed).join(", ") || "none"}; malformed review coverage=${invalidReview}.`,
  );

  const disagreementIds = canonicalStrings(manifest.disagreementCaseIds);
  const adjudicatedCaseIds = new Set(manifest.adjudications.flatMap((entry) => entry.caseIds));
  const disagreementValid =
    uniqueCanonical(manifest.disagreementCaseIds) &&
    disagreementIds.every((caseId) => sealedCaseIds.has(caseId) && adjudicatedCaseIds.has(caseId)) &&
    manifest.adjudications.every(
      (entry) =>
        Date.parse(entry.adjudicatedAt) <= Date.parse(seal.sealedAt) &&
        entry.caseIds.every((caseId) => manifest.disagreementCaseIds.includes(caseId)),
    );
  addCheck(
    checks,
    "semantic-adjudication",
    disagreementValid ? "passed" : "failed",
    `${disagreementIds.length} declared disagreement case(s); each must have a pre-seal adjudication based on safety semantics.`,
  );

  const artifactRefs = [
    ...manifest.reviews.map((entry) => entry.judgmentArtifact),
    ...manifest.adjudications.map((entry) => entry.artifact),
  ];
  const artifactInspection = inspectArtifactRefs(artifactRefs, args.baseDir, args.inspectArtifact);
  addCheck(
    checks,
    "blind-review-file-integrity",
    artifactInspection.valid ? "passed" : "failed",
    artifactInspection.detail,
  );
}

const EXTERNAL_PREREQUISITES: V9HoldoutStatusReport["externalPrerequisites"] = [
  {
    owner: "selection owner",
    requirement:
      "Choose calibration and untouched holdout cases before V8/V9 output access, keep the splits disjoint, and preregister case clusters, matched pairs, thresholds, and the one-shot rule.",
    machineVerifiablePart: "Canonical case IDs, split timing, preregistration digest, and seal bindings.",
  },
  {
    owner: "source archivists",
    requirement:
      "Retrieve immutable source bytes and point-in-time availability proof for every case source; a current mutable URL or a later recollection is insufficient.",
    machineVerifiablePart: "Local file presence, SHA-256, archive-manifest digest, and source/proof timestamps at or before each cutoff.",
  },
  {
    owner: "fact reviewers",
    requirement:
      "At least two reviewers must build or reconcile facts from the frozen archive without outcome or score access, then run the full production V9 fact pipeline rather than authoring final pillars.",
    machineVerifiablePart: "Reviewer separation, production entrypoint receipt, exact-input and compiled-fact hashes, and candidate identity bindings.",
  },
  {
    owner: "independent safety reviewers",
    requirement:
      "At least two reviewers must independently grade or pairwise-order every holdout case without seeing V8/V9 outputs; disagreements require semantic adjudication.",
    machineVerifiablePart: "Reviewer registration and independence, two-review coverage, access attestations, judgment hashes, and adjudication artifacts.",
  },
  {
    owner: "release owner and unseal authority",
    requirement:
      "Freeze policy/producer/build identities, seal exactly once with outcomes withheld, preserve the attempt budget, then authorize one unseal and run the existing holdout-result validator.",
    machineVerifiablePart: "Seal digest, prerequisite states, candidate identities, unseal timing/authority, and one-shot counters.",
  },
];

export function buildV9HoldoutStatus(input: BuildV9HoldoutStatusInput): V9HoldoutStatusReport {
  IsoTimestampSchema.parse(input.generatedAt);
  const historicalCorpus = input.historicalCorpus ?? historicalFixtureAsset;
  const legacyCorpus = summarizeLegacyCorpus(historicalCorpus);
  const checks: V9HoldoutStatusCheck[] = [];
  const inspectArtifact = input.inspectArtifact ?? defaultInspectArtifact;

  let seal: V9ReleaseCandidateSeal | null = null;
  let sealStatus: V9HoldoutStatusReport["suppliedArtifacts"]["seal"] = "not-supplied";
  if (input.sealLoadError) {
    sealStatus = "invalid";
    addCheck(checks, "release-candidate-seal", "failed", `Seal could not be loaded: ${input.sealLoadError}`);
  } else if (input.seal !== undefined) {
    const parsed = V9ReleaseCandidateSealSchema.safeParse(input.seal);
    sealStatus = parsed.success ? "valid" : "invalid";
    if (parsed.success) {
      seal = parsed.data;
      addCheck(checks, "release-candidate-seal", "passed", `Valid seal supplied for ${seal.releaseCandidateId}.`);
      checkSeal(seal, checks);
    } else {
      addCheck(
        checks,
        "release-candidate-seal",
        "failed",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "),
      );
    }
  } else {
    addCheck(checks, "release-candidate-seal", "failed", "No real release-candidate seal was supplied.");
  }

  let sourceArchiveStatus: V9HoldoutStatusReport["suppliedArtifacts"]["sourceArchiveManifest"] = "not-supplied";
  if (input.sourceArchiveManifestLoadError) {
    sourceArchiveStatus = "invalid";
    addCheck(
      checks,
      "source-archive-manifest",
      "failed",
      `Source archive manifest could not be loaded: ${input.sourceArchiveManifestLoadError}`,
    );
  } else if (input.sourceArchiveManifest !== undefined) {
    const parsed = V9HoldoutSourceArchiveManifestSchema.safeParse(input.sourceArchiveManifest);
    sourceArchiveStatus = parsed.success ? "valid" : "invalid";
    if (!parsed.success) {
      addCheck(
        checks,
        "source-archive-manifest",
        "failed",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "),
      );
    } else if (!seal) {
      addCheck(
        checks,
        "source-archive-manifest",
        "failed",
        "A valid archive manifest was supplied, but it cannot be admitted without a valid candidate seal.",
      );
    } else {
      addCheck(checks, "source-archive-manifest", "passed", `Archive manifest supplied for ${parsed.data.holdoutId}.`);
      checkSourceArchive({
        seal,
        manifest: parsed.data,
        baseDir: input.sourceArchiveBaseDir ?? process.cwd(),
        inspectArtifact,
        checks,
      });
    }
  } else {
    addCheck(
      checks,
      "source-archive-manifest",
      "failed",
      "No content-addressed point-in-time source archive manifest was supplied.",
    );
  }

  let blindReviewStatus: V9HoldoutStatusReport["suppliedArtifacts"]["blindReviewManifest"] = "not-supplied";
  if (input.blindReviewManifestLoadError) {
    blindReviewStatus = "invalid";
    addCheck(
      checks,
      "blind-review-manifest",
      "failed",
      `Blind review manifest could not be loaded: ${input.blindReviewManifestLoadError}`,
    );
  } else if (input.blindReviewManifest !== undefined) {
    const parsed = V9HoldoutBlindReviewManifestSchema.safeParse(input.blindReviewManifest);
    blindReviewStatus = parsed.success ? "valid" : "invalid";
    if (!parsed.success) {
      addCheck(
        checks,
        "blind-review-manifest",
        "failed",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "),
      );
    } else if (!seal) {
      addCheck(
        checks,
        "blind-review-manifest",
        "failed",
        "A valid blind review manifest was supplied, but it cannot be admitted without a valid candidate seal.",
      );
    } else {
      addCheck(checks, "blind-review-manifest", "passed", `Blind review manifest supplied for ${parsed.data.holdoutId}.`);
      checkBlindReviews({
        seal,
        manifest: parsed.data,
        baseDir: input.blindReviewBaseDir ?? process.cwd(),
        inspectArtifact,
        checks,
      });
    }
  } else {
    addCheck(
      checks,
      "blind-review-manifest",
      "failed",
      "No two-reviewer blinded judgment and adjudication manifest was supplied.",
    );
  }

  const failedChecks = checks.filter((check) => check.status === "failed");
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    purpose: "gate-3-preparation-status-not-holdout-result",
    decision: failedChecks.length === 0 ? "preparation-ready" : "blocked",
    releaseClaim: "not-a-gate-3-pass",
    legacyCorpus,
    protocolImplementation: {
      validatorPath: "shared/lib/safety-score-v9/validation.ts",
      syntheticExercisePath: "shared/lib/__tests__/safety-score-v9-validation.test.ts",
      syntheticExerciseAdmissibleAsReleaseEvidence: false,
      validatorCanEvaluateBoundReleaseArtifacts: true,
      preparationAddsTwoReviewerFloor: true,
      note:
        "The existing passing 24-case test proves protocol behavior with invented digests and outcomes. It is not a sealed historical corpus.",
    },
    suppliedArtifacts: {
      seal: sealStatus,
      sourceArchiveManifest: sourceArchiveStatus,
      blindReviewManifest: blindReviewStatus,
    },
    checks,
    blockers: failedChecks.map((check) => ({
      code: check.code,
      owner:
        check.code.includes("review") || check.code.includes("adjudication")
          ? "independent reviewers"
          : check.code.includes("archive") || check.code.includes("source")
            ? "source/fact archive owners"
            : "release owner",
      requirement: check.detail,
    })),
    externalPrerequisites: EXTERNAL_PREREQUISITES,
    limitations: [
      "This report checks preparation evidence only. It cannot classify hidden outcomes or declare the holdout passed.",
      "Reviewer access and independence are attestations backed by artifacts; software cannot prove a reviewer did not see an output.",
      "Adverse/resilient balance and score separation remain withheld until the authorized one-shot unseal and existing validation report.",
      "Named user sentinels are excluded from holdout preparation and remain post-rule coherence checks.",
    ],
  };
}

function markdownTableValue(value: unknown): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderV9HoldoutStatusMarkdown(report: V9HoldoutStatusReport): string {
  const checkRows = report.checks
    .map(
      (check) =>
        `| \`${markdownTableValue(check.code)}\` | ${markdownTableValue(check.status)} | ${markdownTableValue(check.detail)} |`,
    )
    .join("\n");
  const blockers =
    report.blockers.length === 0
      ? "- None at the preparation layer. This is still not a holdout-result pass."
      : report.blockers
          .map(
            (blocker) =>
              `- \`${markdownTableValue(blocker.code)}\` (${markdownTableValue(blocker.owner)}): ${markdownTableValue(blocker.requirement)}`,
          )
          .join("\n");
  const prerequisites = report.externalPrerequisites
    .map(
      (entry, index) =>
        `${index + 1}. **${markdownTableValue(entry.owner)}:** ${markdownTableValue(entry.requirement)}\n   Machine-verifiable portion: ${markdownTableValue(entry.machineVerifiablePart)}`,
    )
    .join("\n");
  const legacyLimitations = report.legacyCorpus.limitations
    .map((limitation) => `- ${markdownTableValue(limitation)}`)
    .join("\n");
  const limitations = report.limitations.map((limitation) => `- ${markdownTableValue(limitation)}`).join("\n");

  return `# Safety Score V9 Gate 3 Holdout Status

Generated at: \`${report.generatedAt}\`

Decision: **${report.decision}**

Claim scope: \`${report.releaseClaim}\`. This packet reports preparation status only.

## Current evidence

| Item | Status |
| --- | --- |
| Release-candidate seal | ${report.suppliedArtifacts.seal} |
| Point-in-time source archive manifest | ${report.suppliedArtifacts.sourceArchiveManifest} |
| Two-reviewer blind review manifest | ${report.suppliedArtifacts.blindReviewManifest} |
| Existing validation engine | available |
| Synthetic passing protocol test | not admissible as release evidence |

## Legacy historical corpus

| Metric | Value |
| --- | ---: |
| Fixtures | ${report.legacyCorpus.fixtureCount} |
| Adverse / resilient | ${report.legacyCorpus.adverseCount} / ${report.legacyCorpus.resilientCount} |
| Source records | ${report.legacyCorpus.sourceCount} |
| Capture states | ${markdownTableValue(JSON.stringify(report.legacyCorpus.captureStatuses))} |
| Blinding modes | ${markdownTableValue(JSON.stringify(report.legacyCorpus.blindingModes))} |
| Fact-freeze outcome access | ${markdownTableValue(JSON.stringify(report.legacyCorpus.outcomeAccess))} |
| Same fact/outcome reviewer | ${report.legacyCorpus.sameFactAndOutcomeReviewerCount} |
| Chronology | ${report.legacyCorpus.chronologyStatus} |
| Immutable source evidence | ${report.legacyCorpus.immutableSourceStatus} |
| Independent blinding | ${report.legacyCorpus.independentBlindingStatus} |
| Admissible release holdout | no |

${legacyLimitations}

## Preparation checks

| Check | Status | Detail |
| --- | --- | --- |
${checkRows}

## Blockers

${blockers}

## External prerequisites

${prerequisites}

## Limits

${limitations}
`;
}

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-holdout-status.ts [options]

Options:
  --generated-at <ISO>             Deterministic packet timestamp (required)
  --output <path>                  Output packet path (required)
  --format <markdown|json>         Output format (default: markdown)
  --historical-corpus <path>       Legacy fixture corpus (default: shared/data/safety-score-v9/historical-fixtures-v1.json)
  --seal <path>                    Real release-candidate seal JSON
  --source-archive <path>          Point-in-time source archive manifest JSON
  --blind-review <path>            Two-reviewer blind review manifest JSON
  --require-ready                  Exit nonzero after writing when preparation is blocked
  -h, --help                       Show this help

Omitting candidate artifacts produces a fail-closed status packet; it never substitutes
the retrospective fixtures or synthetic tests for release evidence.`;

interface CliIo {
  readJson(path: string): unknown;
  inspectArtifact(absolutePath: string): ArtifactInspection;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: CliIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  inspectArtifact: defaultInspectArtifact,
  writeText: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
  stdout: process.stdout,
};

function optionalJson(
  path: string | undefined,
  io: CliIo,
): { value: unknown; error: null } | { value: undefined; error: string | null } {
  if (!path) return { value: undefined, error: null };
  try {
    return { value: io.readJson(path), error: null };
  } catch (error) {
    return { value: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

export function runV9HoldoutStatusCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
): V9HoldoutStatusReport | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "generated-at": { type: "string" },
      output: { type: "string" },
      format: { type: "string", default: "markdown" },
      "historical-corpus": { type: "string" },
      seal: { type: "string" },
      "source-archive": { type: "string" },
      "blind-review": { type: "string" },
      "require-ready": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(typeof values["generated-at"] === "string", "--generated-at is required");
  assertCliUsage(typeof values.output === "string", "--output is required");
  assertCliUsage(values.format === "markdown" || values.format === "json", "--format must be markdown or json");

  const historicalPath =
    typeof values["historical-corpus"] === "string"
      ? values["historical-corpus"]
      : "shared/data/safety-score-v9/historical-fixtures-v1.json";
  const sealPath = typeof values.seal === "string" ? values.seal : undefined;
  const archivePath = typeof values["source-archive"] === "string" ? values["source-archive"] : undefined;
  const reviewPath = typeof values["blind-review"] === "string" ? values["blind-review"] : undefined;
  const seal = optionalJson(sealPath, io);
  const archive = optionalJson(archivePath, io);
  const review = optionalJson(reviewPath, io);

  const report = buildV9HoldoutStatus({
    generatedAt: values["generated-at"],
    historicalCorpus: io.readJson(historicalPath),
    seal: seal.value,
    sealLoadError: seal.error,
    sourceArchiveManifest: archive.value,
    sourceArchiveManifestLoadError: archive.error,
    sourceArchiveBaseDir: archivePath ? dirname(resolve(archivePath)) : process.cwd(),
    blindReviewManifest: review.value,
    blindReviewManifestLoadError: review.error,
    blindReviewBaseDir: reviewPath ? dirname(resolve(reviewPath)) : process.cwd(),
    inspectArtifact: io.inspectArtifact,
  });
  const contents =
    values.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderV9HoldoutStatusMarkdown(report);
  io.writeText(values.output, contents);
  if (values["require-ready"] === true && report.decision !== "preparation-ready") {
    throw new Error(`Safety Score v9 Gate 3 preparation is blocked (${report.blockers.length} blocker(s))`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9HoldoutStatusCli(process.argv.slice(2)), {
    label: "safety-score-v9:holdout-status",
    usage: USAGE,
  });
}
