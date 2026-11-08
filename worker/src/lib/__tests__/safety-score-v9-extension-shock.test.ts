import { describe, expect, it } from "vitest";

import shockCoverage from "@shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
import {
  hydrateSafetyScoreV9ShockCoverageAsset,
  selectSafetyScoreV9CdpShockMeasurement,
} from "../safety-score-v9/extension-shock";

const CAPTURE_9_CLOCK_SEC = 1_784_225_942;
const POST_JULY_17_CLOCK_SEC = 1_784_279_256;

type CoverageMeasurement = NonNullable<ReturnType<typeof selectSafetyScoreV9CdpShockMeasurement>>;
type RegistryRow = (typeof shockCoverage.measurements)[number];

function requireMeasurement(assetId: string, clockSec: number) {
  const measurement = selectSafetyScoreV9CdpShockMeasurement(assetId, clockSec);
  if (!measurement) throw new Error(`Expected a shock-coverage measurement for ${assetId}`);
  return measurement;
}

function latestEligibleRow(assetId: string, clockSec: number): RegistryRow {
  const row = shockCoverage.measurements
    .filter((entry) => entry.assetId === assetId && entry.block.timestampUnix <= clockSec)
    .sort((left, right) => right.block.timestampUnix - left.block.timestampUnix)[0];
  if (!row) throw new Error(`Expected an eligible registry row for ${assetId}`);
  return row;
}

function expectRegisteredSelection(measurement: CoverageMeasurement, row: RegistryRow) {
  expect(measurement).toMatchObject({
    family: row.family,
    applicability: row.applicability,
    complete: row.complete,
    exactReplayPassed: row.exactReplayPassed,
    replayVerification: {
      attestedAt: row.replayVerification!.attestedAt,
      mode: row.replayVerification!.mode,
      callsConsumed: row.replayVerification!.callsConsumed,
      codePinsConsumed: row.replayVerification!.codePinsConsumed,
    },
    source: {
      journalPath: row.journalPath,
      journalSha256: row.journalSha256,
      block: row.block,
      sourcePin: row.sourcePin,
    },
    shockPolicy: row.shockPolicy,
    stressShockFraction: row.measuredFacts.stressShockFraction,
    stressLiquidatableDebt: row.measuredFacts.stressLiquidatableDebt,
    stressPoolOffsetDebt: row.measuredFacts.stressPoolOffsetDebt,
    stressLiquidationCoverageRatio: row.measuredFacts.stressLiquidationCoverageRatio,
    branchContributions: row.measuredFacts.branchContributions,
  });
  expect(measurement.codeHashPins).toEqual(row.codePins);
  expect(measurement.codeHashPins).toHaveLength(row.replayVerification!.codePinsConsumed);
  expect(measurement.codeHashPins.every((pin) => /^0x[0-9a-f]{64}$/.test(pin.codeHash))).toBe(true);
}

function expectCoverageArithmetic(measurement: CoverageMeasurement) {
  const debt = BigInt(measurement.stressLiquidatableDebt!);
  const offset = BigInt(measurement.stressPoolOffsetDebt!);
  expect(measurement.stressLiquidationCoverageRatio).toBeCloseTo(debt === 0n ? 1 : Math.min(Number(offset) / Number(debt), 1), 10);
  const branchDebt = measurement.branchContributions.reduce((sum, row) => sum + BigInt(row.stressLiquidatableDebt), 0n);
  const branchOffset = measurement.branchContributions.reduce((sum, row) => sum + BigInt(row.stressPoolOffsetDebt), 0n);
  expect(branchDebt).toBe(debt);
  expect(branchOffset).toBe(offset);
  for (const branch of measurement.branchContributions) {
    const branchDebtValue = BigInt(branch.stressLiquidatableDebt);
    const branchOffsetValue = BigInt(branch.stressPoolOffsetDebt);
    expect(branch.stressLiquidationCoverageRatio).toBeCloseTo(
      branchDebtValue === 0n ? 1 : Math.min(Number(branchOffsetValue) / Number(branchDebtValue), 1),
      10,
    );
  }
}

describe("selectSafetyScoreV9CdpShockMeasurement", () => {
  it("selects Base Dollar's replay-attested five-branch stress measurement", () => {
    const measurement = requireMeasurement("bd-basedollar", 1_787_308_020);
    expectRegisteredSelection(measurement, latestEligibleRow("bd-basedollar", 1_787_308_020));
    expect(measurement.branchContributions).toHaveLength(5);
    expectCoverageArithmetic(measurement);
  });

  it("selects the complete chronology-valid LUSD and BOLD journals at the capture-9 clock", () => {
    for (const assetId of ["lusd-liquity", "bold-liquity"]) {
      const measurement = requireMeasurement(assetId, CAPTURE_9_CLOCK_SEC);
      expectRegisteredSelection(measurement, latestEligibleRow(assetId, CAPTURE_9_CLOCK_SEC));
      expectCoverageArithmetic(measurement);
    }
    const lusd = requireMeasurement("lusd-liquity", CAPTURE_9_CLOCK_SEC);
    expect(lusd.branchContributions).toEqual([
      {
        branchIndex: 0,
        stressLiquidatableDebt: "0",
        stressPoolOffsetDebt: "0",
        stressLiquidationCoverageRatio: 1,
      },
    ]);
    expect(lusd.codeHashPins[0]).toMatchObject({ name: "lusd-token", role: "token" });
    expect(lusd.codeHashPins[lusd.codeHashPins.length - 1]).toMatchObject({ role: "oracle-fallback-source" });
  });

  it("returns no stress measurement for MIM or an unsupported asset", () => {
    expect(selectSafetyScoreV9CdpShockMeasurement("mim-abracadabra", CAPTURE_9_CLOCK_SEC)).toBeUndefined();
    expect(selectSafetyScoreV9CdpShockMeasurement("unsupported-cdp", CAPTURE_9_CLOCK_SEC)).toBeUndefined();
  });

  it("hydrates old extension assets once while preserving replay-pinned measurements", () => {
    const pinnedLusd = requireMeasurement("lusd-liquity", CAPTURE_9_CLOCK_SEC);
    const pinnedAsset = { assetId: "lusd-liquity", archetype: "cdp", cdpStressCoverage: pinnedLusd };

    expect(hydrateSafetyScoreV9ShockCoverageAsset(pinnedAsset, CAPTURE_9_CLOCK_SEC)).toBe(pinnedAsset);
    expect(
      hydrateSafetyScoreV9ShockCoverageAsset({ assetId: "bold-liquity", archetype: "cdp" }, CAPTURE_9_CLOCK_SEC),
    ).toMatchObject({ cdpStressCoverage: {
      stressLiquidationCoverageRatio: latestEligibleRow("bold-liquity", CAPTURE_9_CLOCK_SEC).measuredFacts.stressLiquidationCoverageRatio,
    } });
    expect(
      hydrateSafetyScoreV9ShockCoverageAsset({ assetId: "mim-abracadabra", archetype: "cdp" }, CAPTURE_9_CLOCK_SEC),
    ).not.toHaveProperty("cdpStressCoverage");
  });

  it("rejects a fabricated replay-pinned measurement", () => {
    const fabricated = structuredClone(requireMeasurement("lusd-liquity", CAPTURE_9_CLOCK_SEC));
    if (!fabricated.source) throw new Error("Expected journal provenance");
    fabricated.source.journalSha256 = "f".repeat(64);

    expect(() =>
      hydrateSafetyScoreV9ShockCoverageAsset(
        { assetId: "lusd-liquity", archetype: "cdp", cdpStressCoverage: fabricated },
        CAPTURE_9_CLOCK_SEC,
      ),
    ).toThrow(/not in the committed registry/i);
  });

  it("rejects altered stress metrics under a valid journal identity", () => {
    const pinned = structuredClone(requireMeasurement("bold-liquity", CAPTURE_9_CLOCK_SEC));
    pinned.stressLiquidationCoverageRatio = 0.75;
    expect(() => hydrateSafetyScoreV9ShockCoverageAsset(
      { assetId: "bold-liquity", archetype: "cdp", cdpStressCoverage: pinned },
      CAPTURE_9_CLOCK_SEC,
    )).toThrow(/differs from its committed journal projection/);
  });

  it("admits a journal exactly at its block clock and rejects future pins", () => {
    const blockClock = 1_784_279_255;
    const pinned = requireMeasurement("bold-liquity", blockClock);
    expect(requireMeasurement("bold-liquity", blockClock - 1).source?.block.number)
      .toBe(latestEligibleRow("bold-liquity", blockClock - 1).block.number);
    expect(pinned.source?.block.number).toBe(latestEligibleRow("bold-liquity", blockClock).block.number);
    expect(() => hydrateSafetyScoreV9ShockCoverageAsset(
      { assetId: "bold-liquity", archetype: "cdp", cdpStressCoverage: pinned },
      blockClock - 1,
    )).toThrow(/chronology-valid journal provenance/);
  });

  it("preserves an older valid pin after a newer journal becomes eligible", () => {
    const pinned = requireMeasurement("bold-liquity", CAPTURE_9_CLOCK_SEC);
    const input = { assetId: "bold-liquity", archetype: "cdp", cdpStressCoverage: pinned };
    const hydrated = hydrateSafetyScoreV9ShockCoverageAsset(input, POST_JULY_17_CLOCK_SEC) as typeof input;
    expect(requireMeasurement("bold-liquity", POST_JULY_17_CLOCK_SEC).source?.block.number)
      .toBe(latestEligibleRow("bold-liquity", POST_JULY_17_CLOCK_SEC).block.number);
    expect(hydrated.cdpStressCoverage).toEqual(pinned);
    expect(hydrated.cdpStressCoverage.source?.block.number).toBe(latestEligibleRow("bold-liquity", CAPTURE_9_CLOCK_SEC).block.number);
  });

  it("selects the later LUSD and BOLD journals after the July 17 measurement clock", () => {
    for (const assetId of ["lusd-liquity", "bold-liquity"]) {
      const measurement = requireMeasurement(assetId, POST_JULY_17_CLOCK_SEC);
      expectRegisteredSelection(measurement, latestEligibleRow(assetId, POST_JULY_17_CLOCK_SEC));
      expect(measurement.source!.block.timestampUnix).toBeLessThanOrEqual(POST_JULY_17_CLOCK_SEC);
      expectCoverageArithmetic(measurement);
    }
  });
});
