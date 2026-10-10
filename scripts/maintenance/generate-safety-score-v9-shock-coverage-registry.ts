import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import {
  CAPTURE_SUMMARY_SUFFIX,
  MECHANISM_MEASUREMENT_ROOT,
  capturePathFromSummary,
  parseMechanismCaptureSummary,
} from "../lib/mechanism-measurement/capture-summary";
import {
  ShockMeasuredFactsSchema,
  type ShockCoverageEvidenceV1,
  type ShockMeasuredFactsEvidence,
} from "../lib/mechanism-measurement/shock-schema";
export const SHOCK_COVERAGE_REGISTRY_KIND = "safety-score-v9-shock-coverage-registry" as const;
export const SHOCK_COVERAGE_JOURNAL_ROOT = "shared/data/safety-score-v9/mechanism-measurements" as const;
export const SHOCK_COVERAGE_REGISTRY_PATH = "shared/data/safety-score-v9/shock-coverage-measurements-v1.json" as const;
export const SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH =
  "shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json" as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts [options]

Options:
  --check      Fail instead of writing when the registry is stale
  -h, --help   Show this help`;

export interface CompactShockCoverageCodePin {
  name: string;
  address: string;
  role: string;
  codeHash: string;
}

export interface ShockCoverageRegistryEntry {
  journalPath: string;
  journalSha256: string;
  assetId: string;
  archetype: ShockCoverageEvidenceV1["archetype"];
  family: ShockCoverageEvidenceV1["family"];
  applicability: ShockCoverageEvidenceV1["applicability"]["state"];
  failureReason: ShockCoverageEvidenceV1["applicability"]["failureReason"];
  complete: boolean;
  blockers: string[];
  exactReplayPassed: boolean;
  replayVerification: {
    attestationPath: string;
    attestedAt: string;
    toolPath: string;
    toolVersion: string;
    mode: "offline-byte-identical";
    callsConsumed: number;
    codePinsConsumed: number;
  } | null;
  block: {
    number: number;
    hash: string;
    timestampUnix: number;
    timestampIso: string;
  };
  sourcePin: ShockCoverageEvidenceV1["sourcePin"];
  shockPolicy: ShockCoverageEvidenceV1["shockPolicy"];
  measuredFacts: ShockMeasuredFactsEvidence;
  codePins: CompactShockCoverageCodePin[];
}

const ReplayAttestationsSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-shock-coverage-replay-attestations"),
    replayTool: z
      .object({
        path: z.string().min(1),
        version: z.string().min(1),
        mode: z.literal("offline-byte-identical"),
      })
      .strict(),
    attestedAt: z.string().date(),
    attestations: z.array(
      z
        .object({
          journalPath: z.string().min(1),
          journalSha256: z.string().regex(/^[0-9a-f]{64}$/),
          attestedAt: z.string().date(),
          exactReplayPassed: z.boolean(),
          callsConsumed: z.number().int().nonnegative(),
          codePinsConsumed: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.attestations.map((attestation) => attestation.journalPath);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({ code: "custom", path: ["attestations"], message: "Replay attestation paths must be unique" });
    }
  });

type ReplayAttestations = z.infer<typeof ReplayAttestationsSchema>;

function loadReplayAttestations(root: string): ReplayAttestations | null {
  const path = resolve(root, SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH);
  if (!existsSync(path)) return null;
  return ReplayAttestationsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface ShockCoverageMeasurementRegistryV1 {
  schemaVersion: 1;
  kind: typeof SHOCK_COVERAGE_REGISTRY_KIND;
  measurements: ShockCoverageRegistryEntry[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toRepoPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}


const ShockSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("cdp-shock-coverage-measurement"),
    assetId: z.string().min(1),
    archetype: z.literal("cdp"),
    family: z.union([z.literal("liquity-v1-shock-v1"), z.literal("liquity-v2-shock-v1")]),
    applicability: z.object({ state: z.literal("measured"), failureReason: z.null() }).strict(),
    completeness: z.object({ complete: z.literal(true), blockers: z.array(z.string()).length(0) }).strict(),
    block: z.object({
      number: z.number().int().positive(),
      hash: z.string().regex(/^0x[0-9a-f]{64}$/u),
      timestampUnix: z.number().int().positive(),
      timestampIso: z.string().datetime(),
    }).strict(),
    sourcePin: z.object({ repository: z.string().url(), commit: z.string(), liquidationContractPath: z.string() }).strict(),
    shockPolicy: z.object({
      scoreShockFractionPpm: z.literal(500000),
      sensitivityShockFractionsPpm: z.tuple([
        z.literal(400000),
        z.literal(500000),
        z.literal(600000),
        z.literal(750000),
      ]),
      debtReconciliationTolerancePpm: z.literal(1000),
    }).strict(),
    measuredFacts: ShockMeasuredFactsSchema,
    codePins: z.array(z.object({
      name: z.string().min(1),
      address: z.string().min(1),
      role: z.string().min(1),
      codeHash: z.string().min(1),
    }).strict()).min(1),
    callsConsumed: z.number().int().nonnegative(),
    codePinsConsumed: z.number().int().positive(),
    journalPath: z.string().min(1),
  })
  .strict();

export interface ShockCoverageCaptureSource {
  summaryPath: string;
  capturePath: string;
  summary: ReturnType<typeof parseMechanismCaptureSummary>;
}

export function collectShockCoverageCaptureSources(root = REPO_ROOT): ShockCoverageCaptureSource[] {
  const measurementRoot = resolve(root, MECHANISM_MEASUREMENT_ROOT);
  if (!existsSync(measurementRoot)) {
    throw new Error(`Missing shock-coverage measurement root: ${SHOCK_COVERAGE_JOURNAL_ROOT}`);
  }
  const sources = readdirSync(measurementRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((assetDirectory) => {
      const assetPath = resolve(measurementRoot, assetDirectory.name);
      return readdirSync(assetPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(CAPTURE_SUMMARY_SUFFIX))
        .map((entry) => resolve(assetPath, entry.name));
    })
    .map((summaryPath) => {
      const relativeSummaryPath = toRepoPath(root, summaryPath);
      const summary = parseMechanismCaptureSummary(JSON.parse(readFileSync(summaryPath, "utf8")), relativeSummaryPath);
      return { summaryPath, capturePath: resolve(root, capturePathFromSummary(relativeSummaryPath)), summary };
    })
    .filter((source) => source.summary.summary.kind === "cdp-shock-coverage-measurement")
    .sort((left, right) => compareText(left.summaryPath, right.summaryPath));
  if (sources.length === 0) {
    throw new Error(`No shock-coverage summaries found under ${SHOCK_COVERAGE_JOURNAL_ROOT}`);
  }
  return sources;
}

function projectShockCoverageSource(
  root: string,
  source: ShockCoverageCaptureSource,
  replayAttestations: ReplayAttestations | null,
): ShockCoverageRegistryEntry {
  const journal = ShockSummarySchema.parse(source.summary.summary);
  if (journal.assetId !== source.summary.mechanism) {
    throw new Error(`Shock-coverage summary mechanism mismatch: ${toRepoPath(root, source.summaryPath)}`);
  }
  const journalPath = journal.journalPath;
  const journalSha256 = source.summary.sha256;
  const assetDirectory = journalPath.split("/").at(-2);
  if (assetDirectory !== journal.assetId) {
    throw new Error(`Shock-coverage journal asset mismatch: ${journalPath} contains ${journal.assetId}`);
  }
  if (
    journal.applicability.state !== journal.measuredFacts.applicability ||
    journal.applicability.failureReason !== journal.measuredFacts.failureReason
  ) {
    throw new Error(`Shock-coverage applicability mismatch: ${journalPath}`);
  }
  const replayAttestation = replayAttestations?.attestations.find(
    (attestation) => attestation.journalPath === journalPath && attestation.journalSha256 === journalSha256,
  );
  const exactReplayPassed = replayAttestation?.exactReplayPassed === true;
  return {
    journalPath,
    journalSha256,
    assetId: journal.assetId,
    archetype: journal.archetype,
    family: journal.family,
    applicability: journal.applicability.state,
    failureReason: journal.applicability.failureReason,
    complete: journal.completeness.complete,
    blockers: [...journal.completeness.blockers],
    exactReplayPassed,
    replayVerification:
      exactReplayPassed && replayAttestation && replayAttestations
        ? {
            attestationPath: SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH,
            attestedAt: replayAttestation.attestedAt,
            toolPath: replayAttestations.replayTool.path,
            toolVersion: replayAttestations.replayTool.version,
            mode: replayAttestations.replayTool.mode,
            callsConsumed: replayAttestation.callsConsumed,
            codePinsConsumed: replayAttestation.codePinsConsumed,
          }
        : null,
    block: { ...journal.block },
    sourcePin: { ...journal.sourcePin },
    shockPolicy: {
      ...journal.shockPolicy,
      sensitivityShockFractionsPpm: journal.shockPolicy.sensitivityShockFractionsPpm,
    },
    measuredFacts: {
      ...journal.measuredFacts,
      branchContributions: journal.measuredFacts.branchContributions.map((contribution) => ({ ...contribution })),
    },
    codePins: journal.codePins.map((pin) => ({ ...pin })),
  };
}

export function buildShockCoverageMeasurementRegistry(root = REPO_ROOT): ShockCoverageMeasurementRegistryV1 {
  const replayAttestations = loadReplayAttestations(root);
  const measurements = collectShockCoverageCaptureSources(root)
    .map((source) => projectShockCoverageSource(root, source, replayAttestations))
    .sort(
      (left, right) =>
        compareText(left.assetId, right.assetId) ||
        left.block.timestampUnix - right.block.timestampUnix ||
        compareText(left.journalPath, right.journalPath),
    );

  for (let index = 1; index < measurements.length; index += 1) {
    const previous = measurements[index - 1]!;
    const current = measurements[index]!;
    if (previous.assetId === current.assetId && previous.block.timestampUnix === current.block.timestampUnix) {
      throw new Error(
        `Duplicate shock-coverage measurement clock for ${current.assetId} at ${current.block.timestampUnix}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    kind: SHOCK_COVERAGE_REGISTRY_KIND,
    measurements,
  };
}

export function renderShockCoverageMeasurementRegistry(registry: ShockCoverageMeasurementRegistryV1): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function runShockCoverageMeasurementRegistryGenerator(args = process.argv.slice(2), root = REPO_ROOT): void {
  const { values } = parseStrictCliArgs(args, { options: { check: { type: "boolean" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;

  const registry = buildShockCoverageMeasurementRegistry(root);
  syncGeneratedArtifacts({
    artifacts: [
      {
        path: resolve(root, SHOCK_COVERAGE_REGISTRY_PATH),
        contents: renderShockCoverageMeasurementRegistry(registry),
      },
    ],
    check: values.check === true,
    staleMessage:
      "Shock-coverage measurement registry is stale. Run `npx tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts`.",
    currentMessage: `Shock-coverage measurement registry is current (${registry.measurements.length} journals).`,
    writtenMessage: `Generated shock-coverage measurement registry (${registry.measurements.length} journals).`,
  });
}

runDirectCli(import.meta.url, () => runShockCoverageMeasurementRegistryGenerator(process.argv.slice(2)), {
  label: "generate-safety-score-v9-shock-coverage-registry",
  usage: USAGE,
});
