import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EthCallJournal, EthCallSpec } from "../lib/mechanism-measurement/core";
import { encodeWord } from "../lib/mechanism-measurement/core";
import { measureLiquityV1 } from "../lib/mechanism-measurement/families/liquity-v1";
import { MechanismMeasurementEvidenceV1Schema, type MeasurementCall } from "../lib/mechanism-measurement/schema";
import { CDP_MEASUREMENT_TARGETS } from "../lib/mechanism-measurement/targets";

// Recorded live returndata from block 25533257 (finalized at capture time);
// replaying it must reproduce the committed measurement exactly, no network.
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "lusd-liquity-mechanism-measurement-block-25533257.json"), "utf8"),
) as {
  block: { number: number; hash: string; timestampUnix: number; timestampIso: string };
  calls: MeasurementCall[];
  derived: { priceWei: string; lastGoodPrice: { deltaPct: number } };
  metrics: { collateralizationRatio: number; liquidationCapacityRatio: number };
};

function recordedCaller(overrides: Map<string, string> = new Map()): EthCallJournal {
  const byCallData = new Map(FIXTURE.calls.map((call) => [`${call.to}:${call.callData}`, call.returnData]));
  const calls: MeasurementCall[] = [];
  return {
    calls,
    async call(spec: EthCallSpec): Promise<string> {
      const callData = `${spec.selector}${(spec.args ?? []).map(encodeWord).join("")}`;
      const key = `${spec.to.toLowerCase()}:${callData}`;
      const returnData = overrides.get(key) ?? byCallData.get(key);
      if (!returnData) throw new Error(`No recorded returndata for ${spec.name} (${key})`);
      calls.push({
        name: spec.name,
        to: spec.to.toLowerCase(),
        signature: spec.signature,
        selector: spec.selector,
        callData,
        returnData,
        decoded: "",
      });
      return returnData;
    },
    recordDecoded(decoded: string): void {
      calls[calls.length - 1]!.decoded = decoded;
    },
  };
}

const TARGET = CDP_MEASUREMENT_TARGETS.find((target) => target.assetId === "lusd-liquity")!;
const BLOCK = { ...FIXTURE.block, selection: "operator-pinned" as const };

describe("measureLiquityV1", () => {
  it("reproduces the recorded measurement from replayed returndata", async () => {
    const evidence = await measureLiquityV1(recordedCaller(), TARGET, BLOCK, "https://example.invalid/rpc");
    expect(MechanismMeasurementEvidenceV1Schema.parse(evidence)).toBeTruthy();
    expect(evidence.metrics).toEqual(FIXTURE.metrics);
    expect(evidence.derived.priceWei).toBe(FIXTURE.derived.priceWei);
    expect(evidence.derived.lastGoodPrice.deltaPct).toBe(FIXTURE.derived.lastGoodPrice.deltaPct);
    expect(evidence.checks.every((check) => check.status === "pass")).toBe(true);
    // Deterministic: a second replay yields an identical measurement.
    const again = await measureLiquityV1(recordedCaller(), TARGET, BLOCK, "https://example.invalid/rpc");
    expect(JSON.stringify(again)).toBe(JSON.stringify(evidence));
  });

  it("fails closed when the derived contract graph disagrees with the pinned config", async () => {
    const overrides = new Map([
      [
        // token.troveManagerAddress() returns an unexpected address
        `${TARGET.contracts.token}:0x5a4d28bb`,
        `0x${"00".repeat(12)}${"11".repeat(20)}`,
      ],
    ]);
    await expect(measureLiquityV1(recordedCaller(overrides), TARGET, BLOCK, "https://example.invalid/rpc")).rejects.toThrow(
      /graph\.troveManager/,
    );
  });

  it("fails closed when the protocol price diverges from Chainlink beyond tolerance", async () => {
    const badPrice = 2_100n * 10n ** 18n; // ~12% above the recorded Chainlink answer
    const overrides = new Map([
      [`${TARGET.contracts.priceFeed}:0x0fdb11cf`, `0x${encodeWord(badPrice)}`],
      // getTCR/checkRecoveryMode take the price as an argument, so their
      // recorded returndata would not match; the run must abort before them.
    ]);
    await expect(measureLiquityV1(recordedCaller(overrides), TARGET, BLOCK, "https://example.invalid/rpc")).rejects.toThrow(
      /price\.chainlink-agree/,
    );
  });
});
