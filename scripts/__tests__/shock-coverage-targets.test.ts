import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import committedRegistry from "../../shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
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
  const entry = structuredClone(committedRegistry.measurements[0]);
  return {
    ...entry,
    assetId,
    block: {
      ...entry.block,
      timestampIso: new Date(NOW_SEC * 1_000).toISOString(),
      timestampUnix: NOW_SEC,
    },
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

describe("shock coverage registry admission", () => {
  function evaluate(entries: unknown[], nowSec = NOW_SEC) {
    return evaluateShockCoverageFreshness({
      registry: { measurements: entries },
      maxAgeSec: 72 * 60 * 60,
      nowSec,
      requiredAssetIds: ["bd-basedollar"],
    });
  }

  it("admits a real registry-shaped measurement with valid replay and source provenance", () => {
    expect(evaluate([measurement("bd-basedollar")])).toEqual({
      failures: [],
      successes: [expect.stringContaining("bd-basedollar: OK")],
    });
    const entry = committedRegistry.measurements[0];
    expect(evaluate([entry], entry.block.timestampUnix).failures).toEqual([]);
  });

  it.each([undefined, null, "not-a-clock", NaN, Infinity, -1, 1.5])(
    "rejects malformed block clocks (%s) before choosing the newest row",
    (timestampUnix) => {
      const entry = measurement("bd-basedollar");
      const result = evaluate([
        entry,
        { ...entry, block: { ...entry.block, timestampUnix } },
      ]);
      expect(result.successes).toEqual([]);
      expect(result.failures).toEqual([expect.stringContaining("invalid registry")]);
    },
  );

  it.each([undefined, null, {}])("rejects absent or empty replay attestation (%j)", (replayVerification) => {
    const result = evaluate([{ ...measurement("bd-basedollar"), replayVerification }]);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([expect.stringContaining("replayVerification")]);
  });

  it.each([
    { number: -1 }, { number: 1.5 }, { number: Infinity }, { timestampIso: "invalid" },
  ])("rejects malformed block identity or ISO clocks (%j)", (overrides) => {
    const entry = measurement("bd-basedollar");
    expect(evaluate([{ ...entry, block: { ...entry.block, ...overrides } }]).failures).toEqual([
      expect.stringContaining("invalid registry"),
    ]);
  });

  it("rejects an omitted replay attestation", () => {
    const entry: Record<string, unknown> = measurement("bd-basedollar");
    delete entry.replayVerification;
    expect(evaluate([entry]).failures).toEqual([expect.stringContaining("replayVerification")]);
  });

  it.each([
    { blockers: ["missing branch"] },
    { journalSha256: "invalid" },
    { codePins: [] },
    { exactReplayPassed: false },
  ])("rejects incoherent complete measurement provenance (%j)", (overrides) => {
    const result = evaluate([{ ...measurement("bd-basedollar"), ...overrides }]);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([expect.stringContaining("invalid registry")]);
  });

  it.each([
    { nowSec: NOW_SEC - 1, reason: "future-dated" },
    { nowSec: NOW_SEC + 36 * 60 * 60 + 1, reason: "over the 36h refresh budget" },
  ])("keeps the independent wall-clock rejection: $reason", ({ nowSec, reason }) => {
    expect(evaluate([measurement("bd-basedollar")], nowSec).failures).toEqual([
      expect.stringContaining(reason),
    ]);
  });

  it("admits the unchanged inclusive 36h refresh boundary", () => {
    expect(evaluate([measurement("bd-basedollar")], NOW_SEC + 36 * 60 * 60).failures).toEqual([]);
  });
});

describe("shock coverage refresh workflow cadence", () => {
  const workflow = readFileSync(
    resolve(__dirname, "../../.github/workflows/shock-coverage-refresh.yml"),
    "utf8",
  );

  it("acquires daily and gates the targets job on the same schedule", () => {
    expect(workflow).toContain('- cron: "41 3 * * *"');
    expect(workflow).toContain("github.event.schedule == '41 3 * * *'");
    expect(workflow).not.toContain("*/2");
  });

  it("keeps the independent daily freshness check and manual dispatch", () => {
    expect(workflow).toContain('- cron: "11 9 * * *"');
    expect(workflow).toContain("github.event.schedule == '11 9 * * *'");
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("rejects a complete attested row that is 48h old", () => {
    expect(evaluateShockCoverageFreshness({
      registry: { measurements: [measurement("bd-basedollar")] },
      maxAgeSec: 72 * 60 * 60,
      nowSec: NOW_SEC + 48 * 60 * 60,
      requiredAssetIds: ["bd-basedollar"],
    }).failures).toEqual([expect.stringContaining("over the 36h refresh budget")]);
  });
});
