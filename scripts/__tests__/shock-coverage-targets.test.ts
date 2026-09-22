import { describe, expect, it } from "vitest";
import {
  evaluateShockCoverageFreshness,
  readRequiredAssetIds,
} from "../ci/check-shock-coverage-freshness";
import {
  SHOCK_COVERAGE_TARGET_IDS,
  SHOCK_COVERAGE_TARGETS,
} from "../lib/mechanism-measurement/shock-targets";

const NOW_SEC = 1_000_000;

function measurement(assetId: string) {
  return {
    assetId,
    block: {
      number: 1,
      timestampIso: new Date(NOW_SEC * 1_000).toISOString(),
      timestampUnix: NOW_SEC,
    },
    applicability: "measured",
    complete: true,
    blockers: [],
    exactReplayPassed: true,
    replayVerification: {},
  };
}

describe("shock coverage target authority", () => {
  it("keeps the existing three-target matrix derived from the canonical target definitions", () => {
    expect(SHOCK_COVERAGE_TARGET_IDS).toEqual(SHOCK_COVERAGE_TARGETS.map((target) => target.assetId));
    expect(readRequiredAssetIds({
      targets: SHOCK_COVERAGE_TARGET_IDS.map((assetId) => ({ assetId })),
    })).toEqual(["bd-basedollar", "lusd-liquity", "bold-liquity"]);
    expect(evaluateShockCoverageFreshness({
      registry: { measurements: SHOCK_COVERAGE_TARGET_IDS.map(measurement) },
      maxAgeSec: 72 * 60 * 60,
      nowSec: NOW_SEC,
      requiredAssetIds: SHOCK_COVERAGE_TARGET_IDS,
    }).failures).toEqual([]);
  });

  it("rejects drift between the canonical catalog and derived target IDs", () => {
    expect(() =>
      readRequiredAssetIds(
        { targets: SHOCK_COVERAGE_TARGET_IDS.map((assetId) => ({ assetId })) },
        [...SHOCK_COVERAGE_TARGET_IDS].reverse(),
      ),
    ).toThrow("target assetIds must match the derived shock target IDs");
  });

  it("puts a temporary canonical target in the matrix and fails freshness when its measurement is missing", () => {
    const expectedAssetIds = [...SHOCK_COVERAGE_TARGET_IDS, "temporary-shock-target"];
    const catalog = { targets: expectedAssetIds.map((assetId) => ({ assetId })) };
    const assetIds = readRequiredAssetIds(catalog, expectedAssetIds);
    const registry = { measurements: SHOCK_COVERAGE_TARGET_IDS.map(measurement) };

    expect(assetIds).toContain("temporary-shock-target");
    expect(evaluateShockCoverageFreshness({
      registry,
      maxAgeSec: 72 * 60 * 60,
      nowSec: NOW_SEC,
      requiredAssetIds: assetIds,
    }).failures).toEqual([
      "temporary-shock-target: no measurement in shared/data/safety-score-v9/shock-coverage-measurements-v1.json",
    ]);
  });
});
