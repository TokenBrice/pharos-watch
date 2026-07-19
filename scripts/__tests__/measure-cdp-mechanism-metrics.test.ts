import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EthCallJournal, EthCallSpec } from "../lib/mechanism-measurement/core";
import { encodeWord, ReplayEthCaller } from "../lib/mechanism-measurement/core";
import { measureLiquityV1 } from "../lib/mechanism-measurement/families/liquity-v1";
import { measureLiquityV2 } from "../lib/mechanism-measurement/families/liquity-v2";
import { MechanismMeasurementEvidenceV1Schema, type MeasurementCall } from "../lib/mechanism-measurement/schema";
import { measureConfiguredTarget } from "../lib/mechanism-measurement/measure";
import { CDP_MEASUREMENT_TARGETS } from "../lib/mechanism-measurement/targets";

interface RecordedFixture {
  block: { number: number; hash: string; timestampUnix: number; timestampIso: string };
  calls: MeasurementCall[];
  derived: Record<string, unknown>;
  metrics: { collateralizationRatio: number; liquidationCapacityRatio: number };
}

function loadFixture(name: string): RecordedFixture {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as RecordedFixture;
}

// Recorded live returndata from block 25533257 (finalized at capture time);
// replaying it must reproduce the committed measurement exactly, no network.
const FIXTURE = loadFixture("lusd-liquity-mechanism-measurement-block-25533257.json") as RecordedFixture & {
  derived: { priceWei: string; lastGoodPrice: { deltaPct: number } };
};

function callerFromFixture(fixture: RecordedFixture, overrides: Map<string, string> = new Map()): EthCallJournal {
  const byCallData = new Map(fixture.calls.map((call) => [`${call.to}:${call.callData}`, call.returnData]));
  const calls: MeasurementCall[] = [];
  return {
    calls,
    logQueries: [],
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
    async queryLogs(): Promise<never> {
      throw new Error("Fixture has no recorded log queries");
    },
    recordLogsDecoded(): void {
      throw new Error("Fixture has no recorded log queries");
    },
  };
}

const CANDIDATE = CDP_MEASUREMENT_TARGETS.find((target) => target.assetId === "lusd-liquity")!;
if (CANDIDATE.family !== "liquity-v1") throw new Error("lusd-liquity must be a liquity-v1 target");
const TARGET = CANDIDATE;
const BLOCK = { ...FIXTURE.block, selection: "operator-pinned" as const };

function recordedCaller(overrides: Map<string, string> = new Map()): EthCallJournal {
  return callerFromFixture(FIXTURE, overrides);
}

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
    await expect(
      measureLiquityV1(recordedCaller(overrides), TARGET, BLOCK, "https://example.invalid/rpc"),
    ).rejects.toThrow(/graph\.troveManager/);
  });

  it("fails closed when the protocol price diverges from Chainlink beyond tolerance", async () => {
    const badPrice = 2_100n * 10n ** 18n; // ~12% above the recorded Chainlink answer
    const overrides = new Map([
      [`${TARGET.contracts.priceFeed}:0x0fdb11cf`, `0x${encodeWord(badPrice)}`],
      // getTCR/checkRecoveryMode take the price as an argument, so their
      // recorded returndata would not match; the run must abort before them.
    ]);
    await expect(
      measureLiquityV1(recordedCaller(overrides), TARGET, BLOCK, "https://example.invalid/rpc"),
    ).rejects.toThrow(/price\.chainlink-agree/);
  });
});

describe("measureLiquityV2", () => {
  const V2_FIXTURE = loadFixture("bold-liquity-mechanism-measurement-block-25533671.json");
  const V2_CANDIDATE = CDP_MEASUREMENT_TARGETS.find((target) => target.assetId === "bold-liquity")!;
  if (V2_CANDIDATE.family !== "liquity-v2") throw new Error("bold-liquity must be a liquity-v2 target");
  const V2_TARGET = V2_CANDIDATE;
  const V2_BLOCK = { ...V2_FIXTURE.block, selection: "operator-pinned" as const };

  it("reproduces the recorded multi-branch measurement from replayed returndata", async () => {
    const evidence = await measureLiquityV2(
      callerFromFixture(V2_FIXTURE),
      V2_TARGET,
      V2_BLOCK,
      "https://example.invalid/rpc",
    );
    expect(MechanismMeasurementEvidenceV1Schema.parse(evidence)).toBeTruthy();
    expect(evidence.metrics).toEqual(V2_FIXTURE.metrics);
    expect(evidence.derived.branches).toHaveLength(3);
    expect(evidence.derived.branchCappedLiquidationCapacityRatio).toBe(
      (V2_FIXTURE.derived as { branchCappedLiquidationCapacityRatio: number }).branchCappedLiquidationCapacityRatio,
    );
    expect(evidence.derived.priceCrossCheck.mode).toBe("chainlink-branch0");
    expect(evidence.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails closed on a shut-down branch and on a non-redeemable price", async () => {
    const branch0TroveManager = (V2_FIXTURE.derived as { branches: Array<{ troveManager: string }> }).branches[0]!
      .troveManager;
    const shutDown = new Map([[`${branch0TroveManager}:0x58569081`, `0x${encodeWord(1_750_000_000n)}`]]);
    await expect(
      measureLiquityV2(callerFromFixture(V2_FIXTURE, shutDown), V2_TARGET, V2_BLOCK, "https://example.invalid/rpc"),
    ).rejects.toThrow(/not-shut-down/);

    // redeemable=false with an otherwise valid price must abort
    const recorded = V2_FIXTURE.calls.find(
      (call) => call.to === branch0TroveManager && call.selector === "0x4ea15f37",
    )!;
    const notRedeemable = new Map([
      [`${branch0TroveManager}:0x4ea15f37`, `${recorded.returnData.slice(0, 2 + 64 * 2)}${"0".repeat(64)}`],
    ]);
    await expect(
      measureLiquityV2(
        callerFromFixture(V2_FIXTURE, notRedeemable),
        V2_TARGET,
        V2_BLOCK,
        "https://example.invalid/rpc",
      ),
    ).rejects.toThrow(/branch\[0\]\.price/);
  });
});

const FRESH_MEASUREMENT_ASSETS = [
  "audm-mento",
  "cadm-mento",
  "cdp-enosys",
  "chfm-mento",
  "cjpy-yamato",
  "copm-mento",
  "fxsave-f-x-protocol",
  "fxusd-f-x-protocol",
  "gbpm-mento",
  "gho-aave",
  "ghsm-mento",
  "jpym-mento",
  "kesm-mento",
  "reusd-resupply",
  "usdq-quill",
  "zarm-mento",
] as const;

function loadFreshEvidence(assetId: (typeof FRESH_MEASUREMENT_ASSETS)[number]) {
  const directory = join(__dirname, "../../shared/data/safety-score-v9/mechanism-measurements", assetId);
  const filename = readdirSync(directory).find((candidate) => candidate.startsWith("2026-07-15-block-"));
  if (!filename) throw new Error(`Missing fresh mechanism evidence for ${assetId}`);
  return MechanismMeasurementEvidenceV1Schema.parse(JSON.parse(readFileSync(join(directory, filename), "utf8")));
}

describe("fresh multi-family measurement evidence", () => {
  for (const assetId of FRESH_MEASUREMENT_ASSETS) {
    it(`byte-replays ${assetId} offline`, async () => {
      const recorded = loadFreshEvidence(assetId);
      const target = CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === assetId);
      if (!target) throw new Error(`Missing target for ${assetId}`);
      const caller = new ReplayEthCaller(recorded.calls, recorded.logQueries ?? []);
      const replayed = MechanismMeasurementEvidenceV1Schema.parse(
        await measureConfiguredTarget(caller, target, recorded.block, recorded.rpcUrl),
      );
      caller.assertExhausted();
      expect(replayed).toEqual(recorded);
    });
  }

  it("keeps structural analogues out of liquidation capacity and separates health from coverage", () => {
    for (const assetId of [
      "audm-mento",
      "cadm-mento",
      "chfm-mento",
      "copm-mento",
      "ghsm-mento",
      "jpym-mento",
      "kesm-mento",
      "zarm-mento",
      "gho-aave",
    ] as const) {
      const evidence = loadFreshEvidence(assetId);
      expect(evidence.metrics.liquidationCapacityRatio).toBeNull();
      expect(evidence.metrics.applicability?.liquidationCapacityRatio.state).toBe("not-applicable");
    }
    const yamato = loadFreshEvidence("cjpy-yamato");
    expect(yamato.metrics.liquidationCapacityRatio).toBeNull();
    expect(yamato.family === "yamato-system-v1" && yamato.analogousMetrics.protocolRedemptionPoolRatio).toBeGreaterThan(
      0,
    );

    const quill = loadFreshEvidence("usdq-quill");
    expect(quill.completeness).toEqual({ complete: true, blockers: [] });
    expect(quill.warnings).toEqual([
      "Branch 3 is shut down at timestamp 1775494874.",
      "Branch 3 protocol oracle marks the branch non-redeemable.",
    ]);
    if (quill.family !== "liquity-v2-enumerated-v1") throw new Error("Expected enumerated Liquity evidence");
    expect(quill.derived.branches[3]).toMatchObject({ shutdownTime: 1775494874, redeemable: false });
    expect(quill.checks).toContainEqual({
      id: "branch[3].health-state-captured",
      status: "pass",
      detail: "retained unhealthy state: shutdownTime=1775494874, redeemable=false",
    });
    const fxUsd = loadFreshEvidence("fxusd-f-x-protocol");
    if (fxUsd.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    expect(fxUsd.completeness).toEqual({ complete: true, blockers: [] });
    expect(fxUsd.derived.registeredPools).toEqual([
      "0x6ecfa38fee8a5277b91efda204c235814f0122e8",
      "0xab709e26fa6b0a30c119d8c55b887ded24952473",
    ]);
    expect(fxUsd.logQueries).toHaveLength(1);
    expect(fxUsd.checks).toContainEqual({
      id: "registration.pool-set",
      status: "pass",
      detail: "add-only RegisterPool history contains exactly the 2 configured pools",
    });
    const fxSave = loadFreshEvidence("fxsave-f-x-protocol");
    expect(fxSave.completeness?.complete).toBe(false);
  });

  it("keeps a fully enumerated paused f(x) system complete while retaining the health warning", async () => {
    const recorded = loadFreshEvidence("fxusd-f-x-protocol");
    const target = CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === "fxusd-f-x-protocol");
    if (!target) throw new Error("Missing f(x) target");
    const pauseCall = recorded.calls.find((call) => call.name === "pool[0].isBorrowPaused");
    if (!pauseCall) throw new Error("Missing recorded f(x) pause call");
    const replayCalls = recorded.calls.map((call) =>
      call === pauseCall ? { ...call, returnData: `0x${encodeWord(1n)}` } : call,
    );
    const caller = new ReplayEthCaller(replayCalls, recorded.logQueries ?? []);

    const replayed = MechanismMeasurementEvidenceV1Schema.parse(
      await measureConfiguredTarget(caller, target, recorded.block, recorded.rpcUrl),
    );

    caller.assertExhausted();
    expect(replayed.completeness).toEqual({ complete: true, blockers: [] });
    expect(replayed.warnings).toContain("Pool 0 borrowing is paused.");
    if (replayed.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    expect(replayed.derived.pools[0]).toMatchObject({ borrowPaused: true });
  });
});
