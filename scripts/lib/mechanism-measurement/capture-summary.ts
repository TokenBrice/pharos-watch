import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { ShockCoverageEvidenceV1Schema, type ShockCoverageEvidenceV1 } from "./shock-schema";

export const MECHANISM_MEASUREMENT_ROOT = "shared/data/safety-score-v9/mechanism-measurements";
export const CAPTURE_SUMMARY_SUFFIX = ".summary.json";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export interface MechanismCaptureSummary {
  mechanism: string;
  date: string;
  sha256: string;
  bytes: number;
  r2Key: string;
  summary: Record<string, unknown>;
}

export const MechanismCaptureSummarySchema = z
  .object({
    mechanism: z.string().min(1),
    date: z.string().min(1),
    sha256: Sha256Schema,
    bytes: z.number().int().positive(),
    r2Key: z.string().regex(/^captures\/[^/]+\/[^/]+\.json\.gz$/),
    summary: z.record(z.string(), z.unknown()),
  })
  .strict();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureDate(capturePath: string): string {
  const fileName = basename(capturePath);
  if (!fileName.endsWith(".json")) throw new Error(`Measurement capture must be JSON: ${capturePath}`);
  const date = fileName.slice(0, -".json".length);
  if (!date || date.includes("/") || date.includes("\\")) throw new Error(`Invalid measurement capture date: ${capturePath}`);
  return date;
}

function shockSummary(journal: ShockCoverageEvidenceV1, journalPath: string): Record<string, unknown> {
  return {
    schemaVersion: journal.schemaVersion,
    kind: journal.kind,
    assetId: journal.assetId,
    archetype: journal.archetype,
    family: journal.family,
    applicability: { ...journal.applicability },
    completeness: { ...journal.completeness, blockers: [...journal.completeness.blockers] },
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
      branchContributions: journal.measuredFacts.branchContributions.map((contribution) => ({ ...contribution })),
    },
    codePins: journal.codePins.map(({ name, address, role, codeHash }) => ({ name, address, role, codeHash })),
    callsConsumed: journal.calls.length,
    codePinsConsumed: journal.codePins.length,
    journalPath,
  };
}

function genericSummary(value: Record<string, unknown>, journalPath: string, mechanism: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    assetId: typeof value.assetId === "string" ? value.assetId : mechanism,
    archetype: value.archetype,
    journalPath,
  };
  for (const key of ["capturedAt", "snapshotId", "snapshotObservedAt", "chain", "block"]) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  return summary;
}

export function buildMechanismCaptureSummary(
  rawBytes: Uint8Array,
  capturePath: string,
  root = process.cwd(),
  fallbackMechanism?: string,
): MechanismCaptureSummary {
  const value = JSON.parse(Buffer.from(rawBytes).toString("utf8")) as unknown;
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mechanism =
    typeof record.assetId === "string" && record.assetId.trim()
      ? record.assetId.trim()
      : typeof fallbackMechanism === "string" && fallbackMechanism.trim()
        ? fallbackMechanism.trim()
        : "";
  if (!mechanism) throw new Error(`Measurement capture has no assetId: ${capturePath}`);
  const journalPath = relative(root, resolve(root, capturePath)).split("\\").join("/");
  const date = captureDate(capturePath);
  const summary = record.kind === "cdp-shock-coverage-measurement"
    ? shockSummary(ShockCoverageEvidenceV1Schema.parse(record), journalPath)
    : genericSummary(record, journalPath, mechanism);
  return {
    mechanism,
    date,
    sha256: sha256(rawBytes),
    bytes: rawBytes.byteLength,
    r2Key: `captures/${mechanism}/${date}.json.gz`,
    summary,
  };
}

export function summaryPathForCapture(capturePath: string): string {
  if (!capturePath.endsWith(".json")) throw new Error(`Measurement capture must be JSON: ${capturePath}`);
  return `${capturePath.slice(0, -".json".length)}${CAPTURE_SUMMARY_SUFFIX}`;
}

export function capturePathFromSummary(summaryPath: string): string {
  if (!summaryPath.endsWith(CAPTURE_SUMMARY_SUFFIX)) throw new Error(`Not a capture summary: ${summaryPath}`);
  return `${summaryPath.slice(0, -CAPTURE_SUMMARY_SUFFIX.length)}.json`;
}

export function parseMechanismCaptureSummary(value: unknown, path = "capture summary"): MechanismCaptureSummary {
  const parsed = MechanismCaptureSummarySchema.safeParse(value);
  if (!parsed.success) throw new Error(`${path} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function isMechanismCaptureSummaryPath(path: string): boolean {
  return path.endsWith(CAPTURE_SUMMARY_SUFFIX);
}

export function captureSummaryDirectory(summaryPath: string): string {
  return dirname(summaryPath);
}
