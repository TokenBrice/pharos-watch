import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import wmMetaSource from "@shared/data/stablecoins/coins/wm-m0.json";
import type { BridgeRouteRiskProfile } from "@shared/types/core";

const rpcMocks = vi.hoisted(() => ({
  observeCentrifugeReviewedDeploymentUnitPartitionAttempt: vi.fn(),
  observeXautRepresentationGroupSupplyAttributionAttempt: vi.fn(),
  observeWmReviewedDeploymentUnitPartitionAttempt: vi.fn(),
}));

vi.mock(
  "../safety-score-v9-centrifuge-supply-observer",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../safety-score-v9-centrifuge-supply-observer")
      >();
    return {
      ...original,
      observeCentrifugeReviewedDeploymentUnitPartitionAttempt:
        rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
    };
  },
);

vi.mock("../safety-score-v9-wm-supply-observer", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../safety-score-v9-wm-supply-observer")>();
  return {
    ...original,
    observeWmReviewedDeploymentUnitPartitionAttempt:
      rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt,
  };
});

vi.mock("../safety-score-v9-xaut-supply-observer", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../safety-score-v9-xaut-supply-observer")>();
  return {
    ...original,
    observeXautRepresentationGroupSupplyAttributionAttempt:
      rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt,
  };
});

import {
  captureSafetyScoreV9SupplyAttribution,
  deriveLockMintSupplyPartition,
  safetyScoreV9ChainRows,
  safetyScoreV9ChainSupplyObservedAtSec,
} from "../safety-score-v9-supply-attribution";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9-extension-supply";

const XAUT_TOTAL_SUPPLY_RAW = 707_747_089_000n;
const XAUT_NOT_ISSUED_RAW = 94_923_429_468n;
const XAUT_CIRCULATING_LIABILITY_RAW =
  XAUT_TOTAL_SUPPLY_RAW - XAUT_NOT_ISSUED_RAW;
const XAUT0_LOCKBOX_BALANCE_RAW = 29_714_544_713n;
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

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([
    [
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://ethereum.example",
        explorerUrl: "https://etherscan.io",
      },
    ],
  ]);
}

describe("Safety Score V9 lock/mint supply attribution", () => {
  beforeEach(() => {
    rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt.mockReset();
    rpcMocks.observeXautRepresentationGroupSupplyAttributionAttempt.mockReset();
    rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockReset();
  });

  it("partitions aggregate XAUT without double-counting its XAUt0 lockbox", () => {
    const partition = deriveLockMintSupplyPartition({
      aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
      canonicalCirculatingLiabilityRaw:
        XAUT_CIRCULATING_LIABILITY_RAW,
      lockboxBalancesRaw: [XAUT0_LOCKBOX_BALANCE_RAW],
      canonicalChainLabel: "Ethereum",
      pooledRepresentationLabel: "XAUt0 lock-mint pool",
    });

    expect(partition).not.toBeNull();
    expect(partition!.canonicalSupplyUsd + partition!.pooledRepresentationSupplyUsd).toBe(
      XAUT_AGGREGATE_SUPPLY_USD,
    );
    expect(partition!.pooledRepresentationSupplyUsd / XAUT_AGGREGATE_SUPPLY_USD).toBeCloseTo(
      0.04848792022,
      10,
    );
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
          wmMetaSource.bridgeRouteRisk as BridgeRouteRiskProfile,
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
          deployments: [],
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
  });

  it("skips attribution when an upstream chain partition already exists", async () => {
    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput({ Ethereum: { current: aggregateSupplyUsd } }),
      chainRpcs(),
    );

    expect(capture.attributionById).toEqual({});
    expect(capture.journalRecords).toEqual([]);
    expect(
      rpcMocks.observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
    ).not.toHaveBeenCalled();
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
