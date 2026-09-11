import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SHOCK_COVERAGE_REGISTRY_PATH,
  SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH,
  buildShockCoverageMeasurementRegistry,
  collectShockCoverageCaptureSources,
  renderShockCoverageMeasurementRegistry,
} from "../generate-safety-score-v9-shock-coverage-registry";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

// Compact summaries project committed attestations; this does not replay journal bytes.
// Byte integrity/replay belongs to generate-safety-score-v9-shock-coverage-attestations.
const sources = collectShockCoverageCaptureSources(REPO_ROOT);

describe("Safety Score v9 shock-coverage measurement registry", () => {
  it(
    "is current and exactly projects every compact shock-coverage summary",
    () => {
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
      sources.map((source) => [String(source.summary.summary.journalPath), source]),
    );
    expect(registry.measurements.map((measurement) => measurement.journalPath).sort())
      .toEqual([...sourceByJournalPath.keys()].sort());
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
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(resolve(tmpdir(), "shock-projection-"));
    roots.push(root);
    const summary = structuredClone(sources[0].summary);
    const summaryPath = resolve(root, "shared/data/safety-score-v9/mechanism-measurements", summary.mechanism, "fixture.summary.json");
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify(summary));
    const attestation = {
      journalPath: String(summary.summary.journalPath), journalSha256: summary.sha256,
      attestedAt: "2026-09-01", exactReplayPassed: true, callsConsumed: 7, codePinsConsumed: 2,
    };
    const attestations = {
      schemaVersion: 1, kind: "safety-score-v9-shock-coverage-replay-attestations",
      replayTool: { path: "fixture-replay", version: "1", mode: "offline-byte-identical" },
      attestedAt: "2026-09-01", attestations: [attestation],
    };
    const attestationPath = resolve(root, SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH);
    writeFileSync(attestationPath, JSON.stringify(attestations));
    return { root, summary, summaryPath, attestation, attestations, attestationPath };
  }

  it("trusts only a passing attestation for the exact path and digest", () => {
    const f = fixture();
    expect(buildShockCoverageMeasurementRegistry(f.root).measurements[0]).toMatchObject({
      exactReplayPassed: true, replayVerification: { callsConsumed: 7, codePinsConsumed: 2 },
    });
    for (const state of ["missing", "digest", "failed"]) {
      if (state === "missing") rmSync(f.attestationPath);
      else {
        f.attestations.attestations = [{
          ...f.attestation,
          journalSha256: state === "digest" ? "0".repeat(64) : f.attestation.journalSha256,
          exactReplayPassed: state !== "failed",
        }];
        writeFileSync(f.attestationPath, JSON.stringify(f.attestations));
      }
      expect(buildShockCoverageMeasurementRegistry(f.root).measurements[0]).toMatchObject({
        exactReplayPassed: false, replayVerification: null,
      });
    }
  });

  it("rejects duplicate attestation paths", () => {
    const f = fixture();
    f.attestations.attestations.push({ ...f.attestation });
    writeFileSync(f.attestationPath, JSON.stringify(f.attestations));
    expect(() => buildShockCoverageMeasurementRegistry(f.root)).toThrow(/paths must be unique/);
  });

  it("rejects mechanism and journal-directory identity mismatches", () => {
    const f = fixture();
    writeFileSync(f.summaryPath, JSON.stringify({ ...f.summary, mechanism: "different-mechanism" }));
    expect(() => buildShockCoverageMeasurementRegistry(f.root)).toThrow(/mechanism mismatch/);
    f.summary.summary.journalPath = "captures/different-asset/capture.json";
    writeFileSync(f.summaryPath, JSON.stringify(f.summary));
    expect(() => buildShockCoverageMeasurementRegistry(f.root)).toThrow(/journal asset mismatch/);
  });

  it("rejects duplicate asset clocks even when their journal paths differ", () => {
    const f = fixture();
    f.summary.summary.journalPath = `captures/${f.summary.mechanism}/different.json`;
    writeFileSync(resolve(dirname(f.summaryPath), "second.summary.json"), JSON.stringify(f.summary));
    expect(() => buildShockCoverageMeasurementRegistry(f.root)).toThrow(/Duplicate shock-coverage measurement clock/);
  });
});
