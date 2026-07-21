import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import {
  ShockCoverageEvidenceV1Schema,
  type ShockContractCodePin,
  type ShockCoverageEvidenceV1,
  type ShockMeasuredFactsEvidence,
} from "../lib/mechanism-measurement/shock-schema";

export const SHOCK_COVERAGE_REGISTRY_KIND = "safety-score-v9-shock-coverage-registry" as const;
export const SHOCK_COVERAGE_JOURNAL_ROOT = "shared/data/safety-score-v9/mechanism-measurements" as const;
export const SHOCK_COVERAGE_REGISTRY_PATH = "shared/data/safety-score-v9/shock-coverage-measurements-v1.json" as const;
export const SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH =
  "shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json" as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const JOURNAL_SUFFIX = "-shock-coverage.json";

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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compactCodePin(pin: ShockContractCodePin): CompactShockCoverageCodePin {
  return {
    name: pin.name,
    address: pin.address,
    role: pin.role,
    codeHash: pin.codeHash,
  };
}

export function collectShockCoverageJournalPaths(root = REPO_ROOT): string[] {
  const measurementRoot = resolve(root, SHOCK_COVERAGE_JOURNAL_ROOT);
  if (!existsSync(measurementRoot)) {
    throw new Error(`Missing shock-coverage measurement root: ${SHOCK_COVERAGE_JOURNAL_ROOT}`);
  }

  const paths = readdirSync(measurementRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((assetDirectory) => {
      const assetPath = resolve(measurementRoot, assetDirectory.name);
      return readdirSync(assetPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(JOURNAL_SUFFIX))
        .map((entry) => resolve(assetPath, entry.name));
    })
    .sort(compareText);

  if (paths.length === 0) {
    throw new Error(`No ${JOURNAL_SUFFIX} journals found under ${SHOCK_COVERAGE_JOURNAL_ROOT}`);
  }
  return paths;
}

export function projectShockCoverageJournal(
  root: string,
  absolutePath: string,
  replayAttestations = loadReplayAttestations(root),
): ShockCoverageRegistryEntry {
  const rawBytes = readFileSync(absolutePath);
  const journal = ShockCoverageEvidenceV1Schema.parse(JSON.parse(rawBytes.toString("utf8")));
  const journalPath = toRepoPath(root, absolutePath);
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
  const journalSha256 = sha256(rawBytes);
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
            // Per-entry date: cached attestations keep the date they were
            // actually replayed, so a refresh never rewrites historical rows.
            attestedAt: replayAttestation.attestedAt,
            toolPath: replayAttestations.replayTool.path,
            toolVersion: replayAttestations.replayTool.version,
            mode: replayAttestations.replayTool.mode,
            callsConsumed: replayAttestation.callsConsumed,
            codePinsConsumed: replayAttestation.codePinsConsumed,
          }
        : null,
    block: {
      number: journal.block.number,
      hash: journal.block.hash,
      timestampUnix: journal.block.timestampUnix,
      timestampIso: journal.block.timestampIso,
    },
    sourcePin: { ...journal.sourcePin },
    shockPolicy: {
      ...journal.shockPolicy,
      sensitivityShockFractionsPpm: [...journal.shockPolicy.sensitivityShockFractionsPpm],
    },
    measuredFacts: {
      ...journal.measuredFacts,
      branchContributions: journal.measuredFacts.branchContributions.map((contribution) => ({
        ...contribution,
      })),
    },
    codePins: journal.codePins.map(compactCodePin),
  };
}

export function buildShockCoverageMeasurementRegistry(root = REPO_ROOT): ShockCoverageMeasurementRegistryV1 {
  const replayAttestations = loadReplayAttestations(root);
  const measurements = collectShockCoverageJournalPaths(root)
    .map((path) => projectShockCoverageJournal(root, path, replayAttestations))
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
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(", ")}`);

  const registry = buildShockCoverageMeasurementRegistry(root);
  syncGeneratedArtifacts({
    artifacts: [
      {
        path: resolve(root, SHOCK_COVERAGE_REGISTRY_PATH),
        contents: renderShockCoverageMeasurementRegistry(registry),
      },
    ],
    check: args.includes("--check"),
    staleMessage:
      "Shock-coverage measurement registry is stale. Run `npx tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts`.",
    currentMessage: `Shock-coverage measurement registry is current (${registry.measurements.length} journals).`,
    writtenMessage: `Generated shock-coverage measurement registry (${registry.measurements.length} journals).`,
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runShockCoverageMeasurementRegistryGenerator();
}
