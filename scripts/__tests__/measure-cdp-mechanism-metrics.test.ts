import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EthCallJournal, EthCallSpec } from "../lib/mechanism-measurement/core";
import { encodeWord } from "../lib/mechanism-measurement/core";
import { measureLiquityV1 } from "../lib/mechanism-measurement/families/liquity-v1";
import { measureLiquityV2 } from "../lib/mechanism-measurement/families/liquity-v2";
import { MechanismMeasurementEvidenceV1Schema, type MeasurementCall } from "../lib/mechanism-measurement/schema";
import { redactRpcUrlForEvidence } from "../lib/mechanism-measurement/rpc-provenance";
import { createR2MeasurementsClient } from "../lib/r2-measurements-client";
import { resolveCaptureBody } from "../maintenance/measure-cdp-mechanism-metrics";
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

describe("redactRpcUrlForEvidence", () => {
  it("keeps only the RPC origin for evidence and logs", () => {
    expect(redactRpcUrlForEvidence("https://user:pass@example.com/v3/SECRET?apiKey=PRIVATE#fragment")).toBe(
      "https://example.com",
    );
    expect(redactRpcUrlForEvidence("https://ethereum-rpc.publicnode.com")).toBe("https://ethereum-rpc.publicnode.com");
    expect(redactRpcUrlForEvidence("not a url")).toBe("[invalid-rpc-url]");
  });
});

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

const SYNTHETIC_ADDRESS = "0x1111111111111111111111111111111111111111";
const SYNTHETIC_COUNTER = "0x2222222222222222222222222222222222222222";
const SYNTHETIC_POOL = "0x3333333333333333333333333333333333333333";
const SYNTHETIC_HASH = `0x${"ab".repeat(32)}`;

function syntheticCall(): MeasurementCall {
  return {
    name: "synthetic",
    to: SYNTHETIC_ADDRESS,
    signature: "synthetic()",
    selector: "0x00000000",
    callData: "0x",
    returnData: "0x",
    decoded: "synthetic",
  };
}

function syntheticBase(assetId: string, family: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId,
    archetype: "cdp",
    family,
    chain: { key: "ethereum", evmChainId: 1 },
    rpcUrl: "https://example.invalid/rpc",
    block: {
      number: 1,
      hash: SYNTHETIC_HASH,
      timestampUnix: 1_700_000_000,
      timestampIso: "2023-11-14T22:13:20.000Z",
      selection: "operator-pinned",
    },
    calls: [syntheticCall()],
    metrics: {
      collateralizationRatio: 1,
      liquidationCapacityRatio: null,
      applicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: { state: "not-applicable", rationale: "synthetic fixture" },
      },
    },
    completeness: { complete: true, blockers: [] },
    checks: [{ id: "synthetic.pass", status: "pass", detail: "synthetic fixture" }],
    overlaySources: [{ label: "synthetic", url: "https://example.invalid/source" }],
    tool: { name: "synthetic-test-fixture", version: "1" },
  };
}

function syntheticEvidence(assetId: (typeof FRESH_MEASUREMENT_ASSETS)[number]) {
  if (assetId === "cjpy-yamato") {
    return MechanismMeasurementEvidenceV1Schema.parse({
      ...syntheticBase(assetId, "yamato-system-v1"),
      derived: {
        yamato: SYNTHETIC_ADDRESS,
        currencyOs: SYNTHETIC_COUNTER,
        token: SYNTHETIC_POOL,
        priceFeed: SYNTHETIC_ADDRESS,
        pool: SYNTHETIC_COUNTER,
        totalCollateralRaw: "1",
        totalDebtRaw: "1",
        totalSupplyRaw: "1",
        priceRaw: "1",
        poolBalanceRaw: "1",
        mcrPct: 110,
      },
      analogousMetrics: { protocolRedemptionPoolRatio: 1 },
    });
  }
  if (assetId === "gho-aave") {
    return MechanismMeasurementEvidenceV1Schema.parse({
      ...syntheticBase(assetId, "gho-facilitator-evidence-v1"),
      derived: {
        totalSupplyRaw: "1",
        facilitatorLevelTotalRaw: "1",
        facilitators: [
          { address: SYNTHETIC_ADDRESS, label: "synthetic", bucketCapacityRaw: "1", bucketLevelRaw: "1" },
        ],
        trackedGsms: [],
      },
      analogousMetrics: { facilitatorUnusedCapacityRatio: 1, directSwappableGsmCapacityRatio: 1 },
    });
  }
  if (assetId === "fxsave-f-x-protocol" || assetId === "fxusd-f-x-protocol") {
    const base = syntheticBase(assetId, "fx-protocol-v1");
    const log = {
      address: SYNTHETIC_ADDRESS,
      blockHash: SYNTHETIC_HASH,
      blockNumber: "0x1",
      transactionHash: SYNTHETIC_HASH,
      transactionIndex: "0x0",
      logIndex: "0x0",
      data: "0x",
      topics: [SYNTHETIC_HASH],
      removed: false,
    };
    return MechanismMeasurementEvidenceV1Schema.parse({
      ...base,
      logQueries: [
        {
          name: "synthetic",
          address: SYNTHETIC_ADDRESS,
          fromBlock: 1,
          toBlock: 1,
          topics: [SYNTHETIC_HASH],
          logs: [log],
          decoded: "synthetic",
        },
      ],
      derived: {
        token: SYNTHETIC_ADDRESS,
        poolManager: SYNTHETIC_COUNTER,
        fxBase: SYNTHETIC_POOL,
        totalSupplyRaw: "1",
        legacySupplyRaw: "1",
        totalDebtRaw: "1",
        totalCollateralValueWad: "1",
        fxBaseStableRaw: "1",
        fxBaseYieldRaw: "1",
        fxBaseShareSupplyRaw: "1",
        fxBaseNavRaw: "1",
        registeredPools: [SYNTHETIC_ADDRESS],
        pools: [
          {
            address: SYNTHETIC_ADDRESS,
            collateralToken: SYNTHETIC_COUNTER,
            priceOracle: SYNTHETIC_POOL,
            collateralRaw: "1",
            debtRaw: "1",
            anchorPriceRaw: "1",
            borrowPaused: false,
            redeemPaused: false,
          },
        ],
      },
    });
  }
  if (assetId === "reusd-resupply") {
    return MechanismMeasurementEvidenceV1Schema.parse({
      ...syntheticBase(assetId, "resupply-pairs-v1"),
      derived: {
        token: SYNTHETIC_ADDRESS,
        registry: SYNTHETIC_COUNTER,
        insurancePool: SYNTHETIC_POOL,
        liquidationHandler: SYNTHETIC_ADDRESS,
        totalSupplyRaw: "1",
        totalDebtRaw: "1",
        totalCollateralAssetsRaw: "1",
        insuranceAssetsRaw: "1",
        pairCount: 1,
        supplyDebtDivergencePct: 0,
        pairs: [
          {
            address: SYNTHETIC_ADDRESS,
            underlying: SYNTHETIC_COUNTER,
            collateral: SYNTHETIC_POOL,
            totalBorrowRaw: "1",
            totalCollateralSharesRaw: "1",
            totalCollateralAssetsRaw: "1",
            active: true,
          },
        ],
      },
    });
  }
  if (assetId === "cdp-enosys" || assetId === "usdq-quill") {
    return MechanismMeasurementEvidenceV1Schema.parse({
      ...syntheticBase(assetId, "liquity-v2-enumerated-v1"),
      derived: {
        registry: SYNTHETIC_ADDRESS,
        branches: [
          {
            index: 0,
            collateralToken: SYNTHETIC_COUNTER,
            troveManager: SYNTHETIC_POOL,
            stabilityPool: SYNTHETIC_ADDRESS,
            collateral: "1",
            debt: "1",
            spDeposits: "1",
            priceWei: "1",
            priceUsd: 1,
            redeemable: true,
            shutdownTime: 0,
          },
        ],
        totalCollateralValueWad: "1",
        totalDebtWad: "1",
        spDepositsWad: "1",
        totalSupplyWad: "1",
        supplyDebtDivergencePct: 0,
        branchCappedLiquidationCapacityRatio: 1,
      },
    });
  }
  return MechanismMeasurementEvidenceV1Schema.parse({
    ...syntheticBase(assetId, "mento-conversion-evidence-v1"),
    metrics: {
      collateralizationRatio: null,
      liquidationCapacityRatio: null,
      applicability: {
        collateralizationRatio: { state: "not-applicable", rationale: "synthetic fixture" },
        liquidationCapacityRatio: { state: "not-applicable", rationale: "synthetic fixture" },
      },
    },
    derived: {
      mode: "fpmm-pool",
      selfToken: SYNTHETIC_ADDRESS,
      counterToken: SYNTHETIC_COUNTER,
      pool: SYNTHETIC_POOL,
      counterCapacityRaw: "1",
      feeBps: null,
      totalSupplyRaw: "1",
    },
    analogousMetrics: { conversionCapacityCounterUnits: 1 },
  });
}

function loadFreshEvidence(assetId: (typeof FRESH_MEASUREMENT_ASSETS)[number]) {
  return syntheticEvidence(assetId);
}

function writeSyntheticCapture(assetId: (typeof FRESH_MEASUREMENT_ASSETS)[number]) {
  const directory = mkdtempSync(join(tmpdir(), "pharos-cdp-synthetic-"));
  const bodyPath = join(directory, `${assetId}.json`);
  const summaryPath = `${bodyPath.slice(0, -".json".length)}.summary.json`;
  const cacheDir = join(directory, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const body = Buffer.from(JSON.stringify(loadFreshEvidence(assetId)));
  const sha256 = createHash("sha256").update(body).digest("hex");
  writeFileSync(summaryPath, JSON.stringify({
    mechanism: assetId,
    date: "2026-09-03",
    sha256,
    bytes: body.byteLength,
    r2Key: `captures/${assetId}/2026-09-03.json.gz`,
    summary: { kind: "cdp-mechanism-measurement", assetId, journalPath: bodyPath },
  }));
  writeFileSync(join(cacheDir, `${sha256}.json`), body);
  return { directory, bodyPath, cacheDir, body, sha256 };
}

describe("fresh multi-family measurement evidence", () => {
  for (const assetId of FRESH_MEASUREMENT_ASSETS) {
    it(`byte-replays ${assetId} offline from the local cache`, async () => {
      const capture = writeSyntheticCapture(assetId);
      try {
        const resolved = await resolveCaptureBody(capture.bodyPath, { cacheDir: capture.cacheDir });
        expect(resolved).toEqual(capture.body);
        expect(MechanismMeasurementEvidenceV1Schema.parse(JSON.parse(resolved.toString("utf8")))).toEqual(
          loadFreshEvidence(assetId),
        );
      } finally {
        rmSync(capture.directory, { recursive: true, force: true });
      }
    });
  }

  it("fails closed with the documented expiry error when cache and R2 are empty", async () => {
    const capture = writeSyntheticCapture("audm-mento");
    rmSync(join(capture.cacheDir, `${capture.sha256}.json`));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const r2Client = createR2MeasurementsClient({
      accountId: "account-123",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      fetch: fetchMock,
      now: () => new Date("2026-09-03T12:34:56.000Z"),
    });
    try {
      await expect(resolveCaptureBody(capture.bodyPath, { cacheDir: capture.cacheDir, r2Client })).rejects.toThrow(
        `capture ${capture.sha256} expired: non-replayable`,
      );
    } finally {
      rmSync(capture.directory, { recursive: true, force: true });
    }
  });

  it("keeps structural analogues out of liquidation capacity", () => {
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
    const quill = loadFreshEvidence("usdq-quill");
    expect(quill.completeness).toEqual({ complete: true, blockers: [] });
    if (quill.family !== "liquity-v2-enumerated-v1") throw new Error("Expected enumerated Liquity evidence");
    expect(quill.derived.branches[0]).toMatchObject({ shutdownTime: 0, redeemable: true });
    const fxUsd = loadFreshEvidence("fxusd-f-x-protocol");
    if (fxUsd.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    expect(fxUsd.derived.registeredPools).toEqual([SYNTHETIC_ADDRESS]);
    expect(fxUsd.logQueries).toHaveLength(1);
    const fxSave = loadFreshEvidence("fxsave-f-x-protocol");
    expect(fxSave.completeness?.complete).toBe(true);
  });

  it("retains an enumerated paused f(x) health warning in synthetic replay data", () => {
    const recorded = loadFreshEvidence("fxusd-f-x-protocol");
    if (recorded.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    const pool = recorded.derived.pools[0]!;
    const replayed = MechanismMeasurementEvidenceV1Schema.parse({
      ...recorded,
      derived: { ...recorded.derived, pools: [{ ...pool, borrowPaused: true }] },
    });
    expect(replayed.completeness).toEqual({ complete: true, blockers: [] });
    if (replayed.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    expect(replayed.derived.pools[0]).toMatchObject({ borrowPaused: true });
  });
});
