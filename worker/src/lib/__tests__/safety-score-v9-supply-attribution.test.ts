import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
  createSafetyScoreV9DeploymentSupplyCensusGeneration,
  writeSafetyScoreV9DeploymentSupplyCensusGeneration,
} from "../safety-score-v9/deployment-supply-census-store";
import type { SafetyScoreV9DeploymentSupplyCensus } from "@shared/types/safety-score-v9-deployment-supply-census";
import { chainRpcs } from "./safety-score-v9-supply-observation.test-support";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import wmRiskReview from "@shared/data/stablecoins/domains/risk-review/wm-m0.json";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

const rpcMocks = vi.hoisted(() => ({
  observeCentrifugeReviewedDeploymentUnitPartitionAttempt: vi.fn(),
  observeXautRepresentationGroupSupplyAttributionAttempt: vi.fn(),
  observeWmReviewedDeploymentUnitPartitionAttempt: vi.fn(),
}));

vi.mock(
  "../safety-score-v9/centrifuge-supply-observer",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../safety-score-v9/centrifuge-supply-observer")
      >();
    return {
      ...original,
      observeCentrifugeReviewedDeploymentUnitPartitionAttempt:
        rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
    };
  },
);

vi.mock("../safety-score-v9/wm-supply-observer", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../safety-score-v9/wm-supply-observer")>();
  return {
    ...original,
    observeWmReviewedDeploymentUnitPartitionAttempt:
      rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt,
  };
});

vi.mock("../safety-score-v9/xaut-supply-observer", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../safety-score-v9/xaut-supply-observer")>();
  return {
    ...original,
    observeXautRepresentationGroupSupplyAttributionAttempt:
      rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt,
  };
});

import { captureSafetyScoreV9SupplyAttribution } from "../safety-score-v9/supply-attribution-capture";
import {
  safetyScoreV9SupplyAttributionExpectedAssetIds,
  safetyScoreV9ChainRows,
  safetyScoreV9ChainSupplyMaxAgeSec,
  safetyScoreV9ChainSupplyMaxAgeSecForSource,
  safetyScoreV9ChainSupplyObservedAtSec,
  safetyScoreV9ChainSupplySourceId,
  SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID,
  SAFETY_SCORE_V9_CHAIN_SUPPLY_REVIEWED_DEPLOYMENT_SOURCE_ID,
} from "../safety-score-v9/supply-attribution";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID } from "@shared/types/safety-score-v9";
import { createSafetyScoreV9SupplyAttributionGeneration } from "../safety-score-v9/supply-attribution-generation";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9/extension-supply";
import {
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT_SUPPLY_ATTRIBUTION_CARRY_FORWARD_MAX_AGE_SEC,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
} from "../safety-score-v9/xaut-supply-attribution-contract";
import { makeXautObservation } from "../../test-helpers/v9-fixed-input";
import { createSupplyAttributionPerformance, emitSupplyAttributionDiagnostic } from "../safety-score-v9/supply-attribution-diagnostics";
import { compactCronMetadataForPersistence } from "../cron-metadata-persistence";

const XAUT_AGGREGATE_SUPPLY_USD = 2_480_000_000;
const OBSERVED_AT_SEC = 1_774_000_000;

function xautFixedInput(
  chainCirculating: Record<string, { current: number }> = {},
): ReportCardsFixedInput {
  return {
    activeAssetIds: ["xaut-tether"],
    clockSec: OBSERVED_AT_SEC,
    sourceGeneration: "report-cards:v8:fixture",
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    registryFingerprint: "a".repeat(64),
    chainCirculatingById: { "xaut-tether": chainCirculating },
    aggregateCirculatingById: {
      "xaut-tether": {
        circulating: { peggedGOLD: XAUT_AGGREGATE_SUPPLY_USD },
        observedAtSec: OBSERVED_AT_SEC,
      },
    },
  } as unknown as ReportCardsFixedInput;
}


it("retains bounded asset timings, physical EVM attempts and the last authenticated cursor through compaction", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000);
    const performance = createSupplyAttributionPerformance();
    const original = chainRpcs();
    const observed = performance.withRpcDiagnostics(original)!;
    const [chainId, config] = [...observed][0]!;
    expect(observed).toBe(original);
    config.onRpcRequest?.({ providerOrigin: "https://other.example", method: "batch", rpcCalls: 99, signal: new AbortController().signal });
    vi.setSystemTime(1_100);
    performance.setPhase("pending-authentication");
    for (let i = 0; i < 5; i++) config.onRpcRequest?.({
      providerOrigin: `https://rpc${i}.example`, method: "batch", rpcCalls: 4,
    });
    vi.setSystemTime(1_400);
    performance.setPhase("pending-history");
    emitSupplyAttributionDiagnostic(performance.recordDiagnostic, {
      observer: "ccip", sourceId: "fixture", laneId: "lane", beforeCursor: "100",
      afterCursor: "200", targetCursor: "300", persisted: true,
    });
    vi.setSystemTime(1_600);
    performance.finish();
    expect(original.get(chainId)?.onRpcRequest).toBeUndefined();
    expect(performance.data).toMatchObject({
      elapsedMs: 600, evmRpcRequests: 5, evmRpcCalls: 20, unlistedProviderRequests: 2,
      phaseElapsedMs: { observation: 100, "pending-authentication": 300, "pending-history": 200 },
      lastRpc: { chainId, providerOrigin: "https://rpc4.example", method: "batch" },
      lastCursor: { before: "100", after: "200", target: "300", persisted: true },
    });
    expect(Object.keys(performance.data.providers)).toHaveLength(3);
    const latencySummary = { assets: { fixture: performance.data } };
    const compacted = compactCronMetadataForPersistence(JSON.stringify({
      reason: "supply-attribution-blocking-rejections", latencySummary, oversizedDiagnostic: "x".repeat(20_000),
    }), undefined, "sync-v9-supply-attribution");
    expect(compacted.compacted).toBe(true);
    expect(JSON.parse(compacted.metadata!).latencySummary).toEqual(latencySummary);
    expect(compacted.persistedBytes).toBeLessThanOrEqual(8192);
  } finally {
    vi.useRealTimers();
  }
});

it("retains elapsed time and in-flight RPC context when a child times out", async () => {
  vi.useFakeTimers();
  try {
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockImplementation(async (input) => {
      input.onPhase("pending-authentication");
      const [config] = input.chainRpcs.values();
      config.onRpcRequest({ providerOrigin: "https://slow.example", method: "eth_getCode", rpcCalls: 1, signal: input.signal });
      await new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    });
    const pending = captureSafetyScoreV9SupplyAttribution(xautFixedInput(), chainRpcs());
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    expect(result.failureReasonById?.["xaut-tether"]).toBe("asset-timeout");
    expect(result.performanceById?.["xaut-tether"]).toMatchObject({
      elapsedMs: 30_000, evmRpcRequests: 1,
      phaseElapsedMs: { "pending-authentication": 30_000 },
      lastRpc: { providerOrigin: "https://slow.example", method: "eth_getCode" },
    });
  } finally {
    vi.useRealTimers();
  }
});

describe("Safety Score V9 lock/mint supply attribution", () => {
  beforeEach(() => {
    rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt.mockReset();
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockReset();
    rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockReset();
  });


  it("rejects a wall-clock capture floor before the exact source clock", async () => {
    await expect(
      captureSafetyScoreV9SupplyAttribution(
        xautFixedInput(),
        chainRpcs(),
        undefined,
        {
          clockMode: "wall",
          notBeforeSec: OBSERVED_AT_SEC - 1,
        },
      ),
    ).rejects.toThrow(
      "Supply attribution capture floor must be a safe integer at or after its exact base-input clock",
    );
    expect(
      rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt,
    ).not.toHaveBeenCalled();
  });

  it("journals an unexpected observer failure without trusting the upstream XAUT chain map", async () => {
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockRejectedValue(
      new Error("RPC returned an undecodable deployment state"),
    );
    const fixedInput = xautFixedInput({ Ethereum: { current: XAUT_AGGREGATE_SUPPLY_USD } });
    const capture = await captureSafetyScoreV9SupplyAttribution(fixedInput, chainRpcs());
    expect(capture.attributionById).toEqual({});
    expect(capture.journalRecords).toEqual([expect.objectContaining({
      rejectionCode: "deployment-state-unavailable",
      admissionCode: "supply-attribution.admission.rejected-upstream",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
      failedRouteId: null,
      sourceObservedAtSec: null,
      contentSha256: null,
    })]);
    expect(safetyScoreV9ChainRows({
      ...fixedInput, safetyScoreV9SupplyAttributionById: capture.attributionById,
    }, "xaut-tether")).toEqual({});
  });

  it("propagates cancellation instead of recording an ordinary source rejection", async () => {
    const controller = new AbortController();
    const reason = new Error("Capture cancelled by its lease owner");
    controller.abort(reason);
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockRejectedValue(reason);
    await expect(captureSafetyScoreV9SupplyAttribution(
      xautFixedInput(), chainRpcs(), controller.signal,
    )).rejects.toBe(reason);
  });

  it("rejects a V2 group allocation that underflows aggregate USD supply", () => {
    expect(deriveXautRepresentationGroupSupplyAttribution({
      aggregateSupplyUsd: Number.MIN_VALUE,
      registryFingerprint: "a".repeat(64),
      scoringClockSec: OBSERVED_AT_SEC,
      observation: makeXautObservation({ clockSec: OBSERVED_AT_SEC }),
    })).toBeNull();
  });
  it("captures an identity-bound V9-only group partition and leaves the source row unchanged", async () => {
    const representationGroupSupplyUsd =
      XAUT_AGGREGATE_SUPPLY_USD * 0.04198469365;
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockResolvedValue({
      status: "accepted",
      attribution: {
        model: "canonical-lock-mint-group-partition-v2",
        assetId: "xaut-tether",
        observedAtSec: OBSERVED_AT_SEC - 100,
        registryFingerprint: "a".repeat(64),
        routeInventoryDigest: "b".repeat(64),
        canonical: {
          routeId:
            "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
          chainId: "ethereum",
          currentSupplyUsd:
            XAUT_AGGREGATE_SUPPLY_USD - representationGroupSupplyUsd,
        },
        representationGroup: {
          deploymentRouteKey:
            "representation-group:xaut-tether:xaut0-omnichain",
          representationId: "xaut0-omnichain",
          routeIds: ["arbitrum:xaut0"],
          riskTier: "external-lock-mint",
          failureDomainKeys: ["protocol:xaut0-omnichain"],
          currentSupplyUsd: representationGroupSupplyUsd,
        },
        observation: {
          blockTimeSec: OBSERVED_AT_SEC - 100,
        },
      },
    });
    const fixedInput = xautFixedInput();
    const before = structuredClone(fixedInput);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(
      (OBSERVED_AT_SEC + 60) * 1_000,
    );

    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput,
      chainRpcs(),
      undefined,
      { clockMode: "wall" },
    ).finally(() => nowSpy.mockRestore());
    const captured = capture.attributionById;

    expect(fixedInput).toEqual(before);
    expect(captured["xaut-tether"]).toMatchObject({
      model: "canonical-lock-mint-group-partition-v2",
      observedAtSec: OBSERVED_AT_SEC - 100,
    });
    const attribution = captured["xaut-tether"]!;
    if (attribution.model !== "canonical-lock-mint-group-partition-v2") {
      throw new Error("Expected canonical lock/mint group attribution");
    }
    expect(
      attribution.canonical.currentSupplyUsd +
        attribution.representationGroup.currentSupplyUsd,
    ).toBe(XAUT_AGGREGATE_SUPPLY_USD);
    expect(safetyScoreV9ChainRows({
      ...fixedInput, safetyScoreV9SupplyAttributionById: captured,
    }, "xaut-tether")).toEqual({
      ethereum: { current: XAUT_AGGREGATE_SUPPLY_USD - representationGroupSupplyUsd },
      "representation-group:xaut-tether:xaut0-omnichain": { current: representationGroupSupplyUsd },
    });
    expect(
      rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: "a".repeat(64),
        scoringClockSec: OBSERVED_AT_SEC + 60,
      }),
    );
    expect(capture.captureClockSec).toBe(OBSERVED_AT_SEC + 60);
    expect(capture.journalRecords).toHaveLength(1);
    expect(capture.journalRecords[0]).toMatchObject({
      assetId: "xaut-tether",
      sourceId: "xaut.canonical-lock-mint-group-partition.v2",
      sourceOriginClass: "issuer-disclosure-plus-onchain",
      scoringClockSec: OBSERVED_AT_SEC + 60,
      admissionCode: "supply-attribution.admission.accepted",
      fallbackCode: "supply-attribution.fallback.not-used",
    });
  });

  it("ages an attributed USD partition from its older aggregate observation", () => {
    const fixedInput = xautFixedInput();
    fixedInput.aggregateCirculatingById[
      "xaut-tether"
    ]!.observedAtSec = OBSERVED_AT_SEC - 900;
    fixedInput.safetyScoreV9SupplyAttributionById = {
      "xaut-tether": {
        model: "canonical-lock-mint-partition-v1",
        observedAtSec: OBSERVED_AT_SEC - 100,
        currentSupplyUsdByChain: {
          Ethereum: XAUT_AGGREGATE_SUPPLY_USD * 0.96,
          "XAUt0 lock-mint pool": XAUT_AGGREGATE_SUPPLY_USD * 0.04,
        },
      },
    };

    expect(
      safetyScoreV9ChainRows(fixedInput, "xaut-tether"),
    ).toEqual({
      Ethereum: { current: XAUT_AGGREGATE_SUPPLY_USD * 0.96 },
      "XAUt0 lock-mint pool": {
        current: XAUT_AGGREGATE_SUPPLY_USD * 0.04,
      },
    });

    expect(
      safetyScoreV9ChainSupplyObservedAtSec(
        fixedInput,
        "xaut-tether",
        OBSERVED_AT_SEC,
      ),
    ).toBe(OBSERVED_AT_SEC - 900);

    fixedInput.aggregateCirculatingById[
      "xaut-tether"
    ]!.observedAtSec = null;
    expect(
      safetyScoreV9ChainSupplyObservedAtSec(
        fixedInput,
        "xaut-tether",
        OBSERVED_AT_SEC - 600,
      ),
    ).toBe(OBSERVED_AT_SEC - 600);
  });

  it("rechecks XAUT despite an upstream chain map and fails closed on unavailable evidence", async () => {
    const existing = { Ethereum: { current: XAUT_AGGREGATE_SUPPLY_USD } };
    const fixedInput = xautFixedInput(existing);
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockResolvedValue({
      status: "rejected",
      rejectionCode: "deployment-identity-mismatch",
      rejectedSourceObservedAtSec: null,
      failedRouteId:
        "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
    });
    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput,
      chainRpcs(),
    );
    expect(capture.attributionById).toEqual({});
    expect(
      safetyScoreV9ChainRows(
        {
          ...fixedInput,
          safetyScoreV9SupplyAttributionById: capture.attributionById,
        },
        "xaut-tether",
      ),
    ).toEqual({});
    expect(
      rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt,
    ).toHaveBeenCalledTimes(1);
    expect(capture.journalRecords[0]).toMatchObject({
      admissionCode: "supply-attribution.admission.rejected-identity-drift",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
      rejectionCode: "deployment-identity-mismatch",
      sourceObservedAtSec: null,
    });
  });

  it("journals a bounded post-clock wM Solana-finality packet", async () => {
    rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockResolvedValue({
      status: "accepted",
      attribution: {
        model: "reviewed-deployment-unit-partition-v1",
        assetId: "wm-m0",
        observedAtSec: OBSERVED_AT_SEC + 5,
        captureStartedAtSec: OBSERVED_AT_SEC - 20,
        captureEndedAtSec: OBSERVED_AT_SEC + 5,
        registryFingerprint: "a".repeat(64),
        routeInventoryDigest: "b".repeat(64),
        deployments: [],
      },
    });
    const fixedInput = {
      activeAssetIds: ["wm-m0"],
      clockSec: OBSERVED_AT_SEC,
      sourceGeneration: "report-cards:v8:fixture",
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      registryFingerprint: "a".repeat(64),
      chainCirculatingById: { "wm-m0": {} },
      aggregateCirculatingById: {
        "wm-m0": {
          circulating: { peggedUSD: 87_020_618.58982982 },
          observedAtSec: OBSERVED_AT_SEC,
        },
      },
    } as unknown as ReportCardsFixedInput;

    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput,
      chainRpcs(),
    );

    expect(capture.attributionById["wm-m0"]).toMatchObject({
      observedAtSec: OBSERVED_AT_SEC + 5,
    });
    expect(capture.journalRecords).toHaveLength(1);
    expect(capture.journalRecords[0]).toMatchObject({
      assetId: "wm-m0",
      sourceId: "wm.reviewed-deployment-unit-partition.v1",
      admissionCode: "supply-attribution.admission.accepted",
      sourceObservedAtSec: OBSERVED_AT_SEC + 5,
    });
  });

  it("quarantines a +300s wM packet while the cohort still produces a generation", async () => {
    rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockResolvedValue({
      status: "accepted",
      attribution: {
        model: "reviewed-deployment-unit-partition-v1",
        assetId: "wm-m0",
        observedAtSec: OBSERVED_AT_SEC + 300,
        captureStartedAtSec: OBSERVED_AT_SEC - 20,
        captureEndedAtSec: OBSERVED_AT_SEC + 300,
        registryFingerprint: "a".repeat(64),
        routeInventoryDigest: "b".repeat(64),
        deployments: [],
      },
    });
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt
      .mockResolvedValue({
        status: "rejected",
        rejectionCode: "transparency-source-unavailable",
        rejectedSourceObservedAtSec: null,
        failedRouteId: null,
      });
    const fixedInput = {
      activeAssetIds: ["wm-m0", "xaut-tether"],
      clockSec: OBSERVED_AT_SEC,
      sourceGeneration: "report-cards:v8:fixture",
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      registryFingerprint: "a".repeat(64),
      chainCirculatingById: {
        "wm-m0": {},
        "xaut-tether": {},
      },
      aggregateCirculatingById: {
        "wm-m0": {
          circulating: { peggedUSD: 87_020_618.58982982 },
          observedAtSec: OBSERVED_AT_SEC,
        },
        "xaut-tether": {
          circulating: { peggedGOLD: XAUT_AGGREGATE_SUPPLY_USD },
          observedAtSec: OBSERVED_AT_SEC,
        },
      },
    } as unknown as ReportCardsFixedInput;
    const completedAtSec = OBSERVED_AT_SEC + 300;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(
      completedAtSec * 1_000,
    );

    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput,
      chainRpcs(),
    ).finally(() => nowSpy.mockRestore());

    expect(capture.attributionById).not.toHaveProperty("wm-m0");
    expect(capture.journalRecords).toHaveLength(2);
    expect(
      capture.journalRecords.find((record) => record.assetId === "wm-m0"),
    ).toMatchObject({
      admissionCode: "supply-attribution.admission.rejected-upstream",
      rejectionCode: "deployment-state-unavailable",
      sourceObservedAtSec: null,
    });
    const generation = createSafetyScoreV9SupplyAttributionGeneration({
      fixedInput,
      capture,
      capturedAtSec: completedAtSec,
    });
    expect(generation).toMatchObject({
      observedAssetIds: ["wm-m0", "xaut-tether"],
      acceptedAssetIds: [],
      rejectedAssetIds: ["wm-m0", "xaut-tether"],
    });
  });

  it.each([
    [
      "transparency-source-config-unavailable",
      "supply-attribution.admission.rejected-identity-drift",
    ],
    [
      "transparency-source-unavailable",
      "supply-attribution.admission.rejected-upstream",
    ],
    [
      "transparency-payload-invalid",
      "supply-attribution.admission.rejected-invalid-payload",
    ],
    [
      "transparency-stale",
      "supply-attribution.admission.rejected-stale",
    ],
    [
      "transparency-clock-skew",
      "supply-attribution.admission.rejected-skew",
    ],
    [
      "transparency-onchain-mismatch",
      "supply-attribution.admission.rejected-reconciliation",
    ],
    [
      "transparency-liability-state-invalid",
      "supply-attribution.admission.rejected-reconciliation",
    ],
  ] as const)(
    "maps %s to %s without a generic deployment error",
    async (rejectionCode, admissionCode) => {
      const rejectedSourceObservedAtSec =
        rejectionCode === "transparency-clock-skew"
          ? OBSERVED_AT_SEC + 1
          : rejectionCode === "transparency-stale"
            ? OBSERVED_AT_SEC - 10
            : null;
      rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt
        .mockResolvedValue({
          status: "rejected",
          rejectionCode,
          rejectedSourceObservedAtSec,
          failedRouteId: null,
        });
      const capture = await captureSafetyScoreV9SupplyAttribution(
        xautFixedInput(),
        chainRpcs(),
      );
      expect(capture.journalRecords[0]).toMatchObject({
        sourceOriginClass: "issuer-disclosure-plus-onchain",
        admissionCode,
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        rejectionCode,
        sourceObservedAtSec: rejectedSourceObservedAtSec,
      });
    },
  );

  it.each([
    [
      "deployment-identity-mismatch",
      "supply-attribution.admission.rejected-identity-drift",
    ],
    [
      "deployment-observation-skew",
      "supply-attribution.admission.rejected-skew",
    ],
    [
      "deployment-observation-window-insufficient",
      "supply-attribution.admission.rejected-skew",
    ],
  ] as const)(
    "restores aggregate-only bridge materiality after %s",
    async (rejectionCode, admissionCode) => {
      rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockResolvedValue({
        status: "rejected",
        rejectionCode,
        failedRouteId:
          "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
      });
      const fixedInput = {
        activeAssetIds: ["wm-m0"],
        clockSec: OBSERVED_AT_SEC,
        sourceGeneration: "report-cards:v8:fixture",
        baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
        registryFingerprint: "a".repeat(64),
        chainCirculatingById: { "wm-m0": {} },
        aggregateCirculatingById: {
          "wm-m0": {
            circulating: { peggedUSD: 87_020_618.58982982 },
            observedAtSec: OBSERVED_AT_SEC,
          },
        },
      } as unknown as ReportCardsFixedInput;

      const capture = await captureSafetyScoreV9SupplyAttribution(
        fixedInput,
        chainRpcs(),
      );

      expect(capture.attributionById).not.toHaveProperty("wm-m0");
      expect(capture.journalRecords).toHaveLength(1);
      expect(capture.journalRecords[0]).toMatchObject({
        assetId: "wm-m0",
        admissionCode,
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        rejectionCode,
        failedRouteId:
          "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
        contentSha256: null,
      });
      expect(
        buildSafetyScoreV9SupplyReview(
          {
            ...fixedInput,
            safetyScoreV9SupplyAttributionById: capture.attributionById,
          },
          "wm-m0",
          wmRiskReview.bridgeRouteRisk as BridgeRouteRiskProfile,
        ),
      ).toBeNull();
    },
  );
});

describe("Safety Score V9 Centrifuge burn/mint supply attribution", () => {
  const assetId = "acrdx-anemoy-apollo";
  const aggregateSupplyUsd = 51_033_069.79770032;

  beforeEach(() => {
    rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt.mockReset();
  });

  function fixedInput(
    chainCirculating: Record<string, { current: number }> = {},
  ): ReportCardsFixedInput {
    return {
      activeAssetIds: [assetId],
      clockSec: OBSERVED_AT_SEC,
      sourceGeneration: "report-cards:v8:fixture",
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      registryFingerprint: "a".repeat(64),
      chainCirculatingById: { [assetId]: chainCirculating },
      aggregateCirculatingById: {
        [assetId]: {
          circulating: { peggedUSD: aggregateSupplyUsd },
          observedAtSec: OBSERVED_AT_SEC,
        },
      },
    } as unknown as ReportCardsFixedInput;
  }

  it("admits one complete onchain packet and journals its provenance", async () => {
    rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt
      .mockResolvedValue({
        status: "accepted",
        attribution: {
          model: "reviewed-deployment-unit-partition-v1",
          assetId,
          observedAtSec: OBSERVED_AT_SEC - 10,
          captureStartedAtSec: OBSERVED_AT_SEC - 30,
          captureEndedAtSec: OBSERVED_AT_SEC - 10,
          registryFingerprint: "a".repeat(64),
          routeInventoryDigest: "b".repeat(64),
          deployments: [
            { chainId: "ethereum", currentSupplyUsd: aggregateSupplyUsd * 0.6 },
            { chainId: "ethereum", currentSupplyUsd: aggregateSupplyUsd * 0.1 },
            { chainId: "plume", currentSupplyUsd: aggregateSupplyUsd * 0.3 },
          ],
        },
      });

    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput(),
      chainRpcs(),
    );

    expect(capture.attributionById[assetId]).toMatchObject({
      model: "reviewed-deployment-unit-partition-v1",
      observedAtSec: OBSERVED_AT_SEC - 10,
    });
    expect(
      rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId,
        aggregateSupplyUsd,
        registryFingerprint: "a".repeat(64),
        scoringClockSec: OBSERVED_AT_SEC,
      }),
    );
    expect(capture.journalRecords).toHaveLength(1);
    expect(capture.journalRecords[0]).toMatchObject({
      assetId,
      sourceId: "centrifuge.reviewed-deployment-unit-partition.v1",
      sourceOriginClass: "onchain-observation",
      admissionCode: "supply-attribution.admission.accepted",
      fallbackCode: "supply-attribution.fallback.not-used",
      sourceObservedAtSec: OBSERVED_AT_SEC - 10,
    });
    expect(safetyScoreV9ChainRows({
      ...fixedInput(), safetyScoreV9SupplyAttributionById: capture.attributionById,
    }, assetId)).toEqual({
      ethereum: { current: aggregateSupplyUsd * 0.6 + aggregateSupplyUsd * 0.1 },
      plume: { current: aggregateSupplyUsd * 0.3 },
    });
  });

  it("does not let a positive partial provider row suppress the deployment census", async () => {
    rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt.mockResolvedValue({
      status: "rejected",
      rejectionCode: "deployment-state-unavailable",
      failedRouteId: null,
    });
    const input = fixedInput({ Ethereum: { current: aggregateSupplyUsd } });
    const before = structuredClone(input);
    const capture = await captureSafetyScoreV9SupplyAttribution(input, chainRpcs());

    expect(capture.expectedAssetIds).toEqual([assetId]);
    expect(capture.attributionById).toEqual({});
    expect(capture.journalRecords).toEqual([expect.objectContaining({
      assetId,
      rejectionCode: "deployment-state-unavailable",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
    })]);
    expect(input).toEqual(before);
    expect(rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt).toHaveBeenCalledOnce();
    expect(buildSafetyScoreV9SupplyReview(
      { ...input, safetyScoreV9SupplyAttributionById: capture.attributionById },
      assetId,
      ACTIVE_META_BY_ID.get(assetId)!.bridgeRouteRisk,
    )).toBeNull();
  });

  it("fails closed to aggregate-only when any deployment identity drifts", async () => {
    rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt
      .mockResolvedValue({
        status: "rejected",
        rejectionCode: "deployment-identity-mismatch",
        failedRouteId:
          "plume:0x9477724bb54ad5417de8baff29e59df3fb4da74f",
      });

    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput(),
      chainRpcs(),
    );

    expect(capture.attributionById).not.toHaveProperty(assetId);
    expect(capture.journalRecords[0]).toMatchObject({
      assetId,
      sourceId: "centrifuge.reviewed-deployment-unit-partition.v1",
      admissionCode: "supply-attribution.admission.rejected-identity-drift",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
      rejectionCode: "deployment-identity-mismatch",
      failedRouteId:
        "plume:0x9477724bb54ad5417de8baff29e59df3fb4da74f",
      contentSha256: null,
    });
  });
});

describe("Safety Score V9 chain-supply ceilings (v10.38)", () => {
  const ceilings = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.chainSupplyMaxAgeBySource;
  const defaultCeilingSec = ceilings.defaultMaxAgeSec + ceilings.carryForwardExtraSec;

  function sourceIdOf(attribution: unknown, assetId = "alpha"): string {
    return safetyScoreV9ChainSupplySourceId({
      safetyScoreV9SupplyAttributionById: attribution === undefined ? {} : { [assetId]: attribution },
    } as unknown as SafetyScoreV9CompilerInput, assetId);
  }

  function maxAgeOf(
    attribution: unknown,
    assetId = "alpha",
    declaredMaxAgeSec: number | null = 1800,
  ): number | null {
    return safetyScoreV9ChainSupplyMaxAgeSec({
      clockSec: OBSERVED_AT_SEC,
      aggregateCirculatingById: {},
      chainCirculatingById: {},
      safetyScoreV9SupplyAttributionById: { [assetId]: attribution },
    } as unknown as SafetyScoreV9CompilerInput, assetId, declaredMaxAgeSec);
  }

  it("keeps provider chain-circulating rows at the default-plus-carry ceiling", () => {
    // The policy schema caps the provider entry at default + carry (S-13), so
    // the invariant is expressed through the policy values, not a code literal.
    expect(ceilings.maxAgeSecBySource[V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID]).toBe(defaultCeilingSec);
    expect(defaultCeilingSec).toBe(5_400);
    expect(safetyScoreV9ChainSupplyMaxAgeSecForSource(V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID)).toBe(
      defaultCeilingSec,
    );
    // A source clock that declares a narrower window cannot tighten a listed
    // source: one ceiling replaces the two-part default.
    expect(safetyScoreV9ChainSupplyMaxAgeSecForSource(V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID, 900)).toBe(
      defaultCeilingSec,
    );
    expect(sourceIdOf(undefined)).toBe(V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID);
    expect(maxAgeOf(undefined)).toBe(defaultCeilingSec);
  });

  it("fails an unlisted source closed to the policy default window", () => {
    for (const sourceId of [
      SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID,
      SAFETY_SCORE_V9_CHAIN_SUPPLY_REVIEWED_DEPLOYMENT_SOURCE_ID,
      "unlisted-future-lane",
    ]) {
      expect(safetyScoreV9ChainSupplyMaxAgeSecForSource(sourceId), sourceId).toBe(defaultCeilingSec);
    }
    expect(safetyScoreV9ChainSupplyMaxAgeSecForSource("unlisted-future-lane", null)).toBe(defaultCeilingSec);
  });

  it("lets an unlisted source clock tighten the default window but never widen it", () => {
    const sourceId = SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID;
    const declaredNarrowSec = 900;
    expect(safetyScoreV9ChainSupplyMaxAgeSecForSource(sourceId, declaredNarrowSec)).toBe(
      declaredNarrowSec + ceilings.carryForwardExtraSec,
    );
    expect(safetyScoreV9ChainSupplyMaxAgeSecForSource(sourceId, 30 * 86_400)).toBe(defaultCeilingSec);
  });

  it("resolves every attribution model to the source id its ceiling is keyed by", () => {
    expect(sourceIdOf({ model: "canonical-lock-mint-partition-v1" })).toBe(
      SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID,
    );
    expect(sourceIdOf({ model: "canonical-lock-mint-group-partition-v2" })).toBe(
      SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID,
    );
    expect(sourceIdOf({ model: "reviewed-deployment-unit-partition-v1" })).toBe(
      SAFETY_SCORE_V9_CHAIN_SUPPLY_REVIEWED_DEPLOYMENT_SOURCE_ID,
    );
    expect(sourceIdOf({ model: "reviewed-economic-deployment-partition-v1" })).toBe(
      V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.journalSourceId,
    );
  });

  it("keeps per-asset lane admission windows ahead of the generic source ceiling", () => {
    const supplyPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
    // A reviewed economic partition is admitted inside its own pin window, so
    // its evidence cannot borrow the wider generic ceiling.
    expect(maxAgeOf({
      model: "reviewed-economic-deployment-partition-v1",
      deployments: [{ chainId: "ethereum" }],
    })).toBe(supplyPolicy.observationMaxAgeSec);
    expect(maxAgeOf({
      model: "reviewed-economic-deployment-partition-v1",
      deployments: [{ chainId: "ethereum" }, { chainId: "optimism" }],
    })).toBe(supplyPolicy.observationMaxAgeSec + supplyPolicy.finalityMarginSecByChainId.optimism!);
    // XAUT's finalized observation keeps its one-hour window, carried or not.
    expect(maxAgeOf({ model: "canonical-lock-mint-group-partition-v2" }, "xaut-tether")).toBe(
      XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
    );
    expect(maxAgeOf({
      model: "canonical-lock-mint-group-partition-v2",
      carriedForwardFromGenerationId: "gen-prior",
    }, "xaut-tether")).toBe(XAUT_SUPPLY_ATTRIBUTION_CARRY_FORWARD_MAX_AGE_SEC);
    expect(XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC).toBeLessThan(defaultCeilingSec);
  });
});

describe("Supply attribution shadow census projection", () => {
  const CENSUS_TOKEN = `0x${"d".repeat(40)}`;

  function censusPacket(): SafetyScoreV9DeploymentSupplyCensus {
    const supply = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
    const shareUpper = 1 / XAUT_AGGREGATE_SUPPLY_USD;
    return {
      model: "deployment-supply-census-v1",
      observedAtSec: OBSERVED_AT_SEC,
      deployments: [{
        routeId: `ethereum:${CENSUS_TOKEN}`,
        chainId: "ethereum",
        tokenAddress: CENSUS_TOKEN,
        readKind: "evm-total-supply",
        pin: {
          kind: "evm-header",
          blockNumber: 20_000_000,
          blockHash: `0x${"b".repeat(64)}`,
          blockTimeSec: OBSERVED_AT_SEC - 60,
          runtimeCodeSha256: "a".repeat(64),
        },
        decimals: 6,
        totalSupplyRaw: "1000000",
        referencePriceUsd: 1,
        referencePriceObservedAtSec: OBSERVED_AT_SEC - 30,
        supplyUsdUpper: 1,
        shareUpper,
        evidenceKind: "upper-bound",
      }],
      conservation: {
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        measuredSupplyUsd: 1,
        measuredShareSum: shareUpper,
        relativeTolerance: supply.conservationRelativeTolerance,
        absoluteToleranceUsd: supply.conservationAbsoluteToleranceUsd,
        rosterComplete: true,
        conserved: true,
      },
      rejected: [],
    };
  }

  it("carries the admitted census map and its provenance, and adds no key when absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(OBSERVED_AT_SEC * 1_000);
    const uuid = vi.spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000000");
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockResolvedValue({
      status: "rejected",
      rejectionCode: "deployment-state-unavailable",
      failedRouteId: null,
    });
    const withCensus = createLatestSchemaSqlite();
    const withoutCensus = createLatestSchemaSqlite();
    try {
      const generation = createSafetyScoreV9DeploymentSupplyCensusGeneration({
        schemaVersion: 1,
        kind: "safety-score-v9-deployment-supply-census-generation",
        sourceBaseInputGenerationId: xautFixedInput().baseInputGenerationId,
        registryFingerprint: xautFixedInput().registryFingerprint,
        capturedAtSec: OBSERVED_AT_SEC,
        censusById: { "xaut-tether": censusPacket() },
      });
      await writeSafetyScoreV9DeploymentSupplyCensusGeneration(withCensus.db, generation);

      const carried = await captureSafetyScoreV9SupplyAttribution(
        xautFixedInput(),
        chainRpcs(),
        undefined,
        { clockMode: "source", db: withCensus.db },
      );
      expect(carried.deploymentSupplyCensusById).toEqual({ "xaut-tether": censusPacket() });
      expect(carried.deploymentSupplyCensus).toEqual({
        state: "ok",
        generationId: generation.generationId,
        capturedAtSec: OBSERVED_AT_SEC,
        // SA-FIX F2: the provenance names the input the map is bound to, so no
        // carrier has to re-read the store to prove which generation it holds.
        registryFingerprint: xautFixedInput().registryFingerprint,
        sourceBaseInputGenerationId: xautFixedInput().baseInputGenerationId,
        maxAgeSec: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
        excluded: [],
      });

      const absent = await captureSafetyScoreV9SupplyAttribution(
        xautFixedInput(), chainRpcs(), undefined, { clockMode: "source", db: withoutCensus.db },
      );
      const storeless = await captureSafetyScoreV9SupplyAttribution(
        xautFixedInput(), chainRpcs(), undefined, { clockMode: "source" },
      );
      expect("deploymentSupplyCensusById" in absent).toBe(false);
      expect("deploymentSupplyCensus" in absent).toBe(false);
      // The absent case carries the same fixed-input surface as before the
      // store read existed: no census keys and no other shape change.
      const structural = (capture: typeof absent) => stableJsonStringifyV1({
        ...capture, journalRecords: [], performanceById: {},
      });
      expect(Object.keys(absent).sort()).toEqual(Object.keys(storeless).sort());
      expect(structural(absent)).toBe(structural(storeless));
    } finally {
      uuid.mockRestore();
      withCensus.sqlite.close();
      withoutCensus.sqlite.close();
      vi.useRealTimers();
    }
  });
});
describe("Supply attribution complete-provider precedence", () => {
  it("requires every wM chain, including observed-zero legs, before skipping its census", () => {
    const assetId = "wm-m0";
    const routes = ACTIVE_META_BY_ID.get(assetId)!.bridgeRouteRisk!.routes!;
    const chains = routes.map(route => route.destinationChain!);
    expect(new Set(chains).size).toBe(chains.length);
    const rows = Object.fromEntries(chains.map((chain, index) => {
      const current = index === 0 ? 100 : 0;
      return [chain, {
        current,
        circulatingPrevDay: current,
        circulatingPrevWeek: current,
        circulatingPrevMonth: current,
      }];
    }));
    const input: ReportCardsFixedInput = {
      ...xautFixedInput(),
      activeAssetIds: [assetId],
      chainCirculatingById: { [assetId]: rows },
      aggregateCirculatingById: { [assetId]: { circulating: { peggedUSD: 100 }, observedAtSec: OBSERVED_AT_SEC } },
    };
    expect(safetyScoreV9SupplyAttributionExpectedAssetIds(input)).toEqual([]);

    const incomplete = structuredClone(input);
    delete incomplete.chainCirculatingById[assetId]![chains[chains.length - 1]!];
    expect(safetyScoreV9SupplyAttributionExpectedAssetIds(incomplete)).toEqual([assetId]);

    const inconsistent = structuredClone(input);
    inconsistent.chainCirculatingById[assetId]![chains[0]!]!.current = 99;
    expect(safetyScoreV9SupplyAttributionExpectedAssetIds(inconsistent)).toEqual([assetId]);

    const stale = structuredClone(input);
    stale.aggregateCirculatingById[assetId]!.observedAtSec = OBSERVED_AT_SEC - 7_200;
    expect(safetyScoreV9SupplyAttributionExpectedAssetIds(stale)).toEqual([assetId]);
  });
});
