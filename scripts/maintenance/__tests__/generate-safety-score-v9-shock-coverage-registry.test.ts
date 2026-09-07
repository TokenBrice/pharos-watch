import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SHOCK_COVERAGE_REGISTRY_PATH,
  SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH,
  buildShockCoverageMeasurementRegistry,
  collectShockCoverageCaptureSources,
  collectShockCoverageJournalPaths,
  renderShockCoverageMeasurementRegistry,
} from "../generate-safety-score-v9-shock-coverage-registry";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

// This case reads, schema-parses, and hashes every committed shock-coverage journal.
// The corpus grows with each capture — the 2026-08-17 refresh alone added roughly
// 38k lines — so the default 5s budget is exceeded on CI runners while still passing
// locally. The assertion is a whole-corpus projection proof, so narrowing its input
// would weaken it; give it an explicit budget instead, as the other whole-registry
// V9 suites do.
const SHOCK_COVERAGE_REGISTRY_TEST_TIMEOUT_MS = 60_000;

describe("Safety Score v9 shock-coverage measurement registry", () => {
  it(
    "is current and exactly projects every shock-coverage journal",
    { timeout: SHOCK_COVERAGE_REGISTRY_TEST_TIMEOUT_MS },
    () => {
    const journalPaths = collectShockCoverageJournalPaths(REPO_ROOT);
    const registry = buildShockCoverageMeasurementRegistry(REPO_ROOT);
    const rendered = renderShockCoverageMeasurementRegistry(registry);
    const committed = readFileSync(resolve(REPO_ROOT, SHOCK_COVERAGE_REGISTRY_PATH), "utf8");
    const committedAttestations = JSON.parse(
      readFileSync(resolve(REPO_ROOT, SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH), "utf8"),
    ) as { attestations: { journalPath: string; journalSha256: string; attestedAt: string }[] };
    const attestationByKey = new Map(
      committedAttestations.attestations.map((entry) => [`${entry.journalPath}@${entry.journalSha256}`, entry]),
    );

    expect(committed).toBe(rendered);
    expect(registry.measurements).toHaveLength(journalPaths.length);
    expect(
      registry.measurements.map((measurement) => [
        measurement.assetId,
        measurement.block.timestampUnix,
        measurement.journalPath,
      ]),
    ).toEqual(
      [...registry.measurements]
        .sort(
          (left, right) =>
            left.assetId.localeCompare(right.assetId) ||
            left.block.timestampUnix - right.block.timestampUnix ||
            left.journalPath.localeCompare(right.journalPath),
        )
        .map((measurement) => [measurement.assetId, measurement.block.timestampUnix, measurement.journalPath]),
    );

    const sourceByJournalPath = new Map(
      collectShockCoverageCaptureSources(REPO_ROOT).map((source) => [String(source.summary.summary.journalPath), source]),
    );
    for (const measurement of registry.measurements) {
      const source = sourceByJournalPath.get(measurement.journalPath);
      if (!source) throw new Error(`Missing summary for ${measurement.journalPath}`);
      const summary = source.summary.summary;
      if (!summary || typeof summary !== "object") throw new Error(`Invalid summary for ${measurement.journalPath}`);

      expect(measurement.journalSha256).toBe(source.summary.sha256);
      expect(summary).toMatchObject({
        assetId: measurement.assetId,
        archetype: measurement.archetype,
        family: measurement.family,
        applicability: { state: measurement.applicability, failureReason: measurement.failureReason },
        completeness: { complete: measurement.complete, blockers: measurement.blockers },
        measuredFacts: { applicability: measurement.applicability, failureReason: measurement.failureReason },
        block: measurement.block,
        sourcePin: measurement.sourcePin,
        shockPolicy: measurement.shockPolicy,
        codePins: measurement.codePins,
      });
      expect(measurement.exactReplayPassed).toBe(true);
      const attestation = attestationByKey.get(`${measurement.journalPath}@${measurement.journalSha256}`);
      if (!attestation) throw new Error(`Missing committed attestation for ${measurement.journalPath}`);
      expect(attestation.attestedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(measurement.replayVerification).toMatchObject({
        attestedAt: attestation.attestedAt,
        mode: "offline-byte-identical",
        callsConsumed: summary.callsConsumed,
        codePinsConsumed: summary.codePinsConsumed,
      });
      expect(measurement).not.toHaveProperty("calls");
      expect(measurement).not.toHaveProperty("positions");
      expect(measurement.codePins.every((pin) => !("bytecode" in pin))).toBe(true);
    }
    const capture9 = registry.measurements.filter((measurement) => measurement.block.timestampUnix === 1784225939);
    const july17 = registry.measurements.filter((measurement) => measurement.block.timestampUnix === 1784279255);
    expect(capture9.map((measurement) => measurement.assetId)).toEqual(["bold-liquity", "lusd-liquity"]);
    expect(july17.map((measurement) => measurement.assetId)).toEqual(["bold-liquity", "lusd-liquity"]);
    },
  );
});
