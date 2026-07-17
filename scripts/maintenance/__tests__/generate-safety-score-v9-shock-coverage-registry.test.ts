import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ShockCoverageEvidenceV1Schema } from "../../lib/mechanism-measurement/shock-schema";
import {
  SHOCK_COVERAGE_REGISTRY_PATH,
  buildShockCoverageMeasurementRegistry,
  collectShockCoverageJournalPaths,
  renderShockCoverageMeasurementRegistry,
} from "../generate-safety-score-v9-shock-coverage-registry";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

describe("Safety Score v9 shock-coverage measurement registry", () => {
  it("is current and exactly projects every shock-coverage journal", () => {
    const journalPaths = collectShockCoverageJournalPaths(REPO_ROOT);
    const registry = buildShockCoverageMeasurementRegistry(REPO_ROOT);
    const rendered = renderShockCoverageMeasurementRegistry(registry);
    const committed = readFileSync(resolve(REPO_ROOT, SHOCK_COVERAGE_REGISTRY_PATH), "utf8");

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

    for (const measurement of registry.measurements) {
      const rawBytes = readFileSync(resolve(REPO_ROOT, measurement.journalPath));
      const journal = ShockCoverageEvidenceV1Schema.parse(JSON.parse(rawBytes.toString("utf8")));

      expect(measurement.journalSha256).toBe(createHash("sha256").update(rawBytes).digest("hex"));
      expect(measurement.assetId).toBe(journal.assetId);
      expect(measurement.archetype).toBe(journal.archetype);
      expect(measurement.family).toBe(journal.family);
      expect(measurement.applicability).toBe(journal.applicability.state);
      expect(measurement.failureReason).toBe(journal.applicability.failureReason);
      expect(measurement.applicability).toBe(journal.measuredFacts.applicability);
      expect(measurement.failureReason).toBe(journal.measuredFacts.failureReason);
      expect(measurement.complete).toBe(journal.completeness.complete);
      expect(measurement.blockers).toEqual(journal.completeness.blockers);
      expect(measurement.exactReplayPassed).toBe(true);
      expect(measurement.replayVerification).toMatchObject({
        attestedAt: "2026-07-17",
        mode: "offline-byte-identical",
        callsConsumed: journal.calls.length,
        codePinsConsumed: journal.codePins.length,
      });
      expect(measurement.block).toEqual({
        number: journal.block.number,
        hash: journal.block.hash,
        timestampUnix: journal.block.timestampUnix,
        timestampIso: journal.block.timestampIso,
      });
      expect(measurement.sourcePin).toEqual(journal.sourcePin);
      expect(measurement.shockPolicy).toEqual(journal.shockPolicy);
      expect(measurement.measuredFacts).toEqual(journal.measuredFacts);
      expect(measurement.codePins).toEqual(
        journal.codePins.map(({ name, address, role, codeHash }) => ({
          name,
          address,
          role,
          codeHash,
        })),
      );
      expect(measurement).not.toHaveProperty("calls");
      expect(measurement).not.toHaveProperty("positions");
      expect(measurement.codePins.every((pin) => !("bytecode" in pin))).toBe(true);
    }

    const capture9 = registry.measurements.filter((measurement) => measurement.block.timestampUnix === 1784225939);
    const july17 = registry.measurements.filter((measurement) => measurement.block.timestampUnix === 1784279255);
    expect(capture9.map((measurement) => measurement.assetId)).toEqual(["bold-liquity", "lusd-liquity"]);
    expect(july17.map((measurement) => measurement.assetId)).toEqual(["bold-liquity", "lusd-liquity"]);
  });
});
