import { describe, expect, it } from "vitest";
import {
  buildFpiControllerV9ExitRouteObservation,
  parseAcceptedFpiControllerV9RouteState,
  type FpiControllerV9RouteState,
} from "../fpi-controller-redemption-route";

const NOW = 1_790_000_000;
const PEG_PRICE_USD = 1.1579360716249116;
const QUOTE_OUTPUT_FRAX = 1.1544622634100368;
const OUTPUT_PRICE_USD = 0.98839875;
const MAX_REDEEMABLE_FPI = 537_994.248;
const ALL_IN_COST_BPS =
  (1 - (QUOTE_OUTPUT_FRAX * OUTPUT_PRICE_USD) / PEG_PRICE_USD) * 10_000;
const STATE: FpiControllerV9RouteState = {
  kind: "fpi-controller-v1",
  chain: "ethereum",
  controllerAddress: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
  controllerCodeHash: "0x8f8968ffbb928926343d4217667f094cc938f359e253ef25ff33ee7b85ec1132",
  blockNumber: 25_600_682,
  blockTimestamp: NOW - 30,
  inputTokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e",
  outputTokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e",
  outputTrackedAssetId: "frax-frax",
  fraxPriceFeedAddress: "0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd",
  fraxPriceFeedCodeHash: "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
  fraxPriceFeedRoundId: "36893488147419121260",
  fraxPriceFeedUpdatedAt: NOW - 120,
  fraxPriceFeedAgeSec: 90,
  fpiPriceFeedAddress: "0x59985d79e1e69f659f4ab97db07a35ce73d9174b",
  fpiPriceFeedCodeHash: "0x2b165ff401e6d9ee29c0ef100b238ecb2fb7c89715104dde46b95547cea302fb",
  fpiPriceFeedRoundId: "0",
  fpiPriceFeedUpdatedAt: NOW - 30,
  fpiPriceFeedAgeSec: 0,
  maxPriceFeedAgeSec: 7_200,
  cpiTrackerAddress: "0x66b7dff2ac66dc4d6fbb3db1cb627bbb01ff3146",
  cpiTrackerCodeHash: "0xb989d68e59e9df4ef6d1782d56efe24f44bbb1d9e015c523c6e30adde9a7821d",
  cpiTrackerUpdatedAt: NOW - 90 * 86_400,
  cpiTrackerAgeSec: 90 * 86_400 - 30,
  fullConfidenceCpiTrackerAgeSec: 62 * 86_400,
  maxCpiTrackerAgeSec: 366 * 86_400,
  cpiTrackerFreshness: "stale-bounded",
  modelConfidence: "medium",
  feeBps: 30,
  pegPriceUsd: PEG_PRICE_USD,
  fpiPriceUsd: 1.1539523089251496,
  pegDifferenceBps: 34.52,
  pegBandBps: 500,
  quoteInputFpi: 1,
  quoteOutputFrax: QUOTE_OUTPUT_FRAX,
  outputPriceUsd: OUTPUT_PRICE_USD,
  allInCostBps: ALL_IN_COST_BPS,
  controllerOutputBalance: 621_116.7543201557,
  maxRedeemableFpi: MAX_REDEEMABLE_FPI,
  capacityUsd: MAX_REDEEMABLE_FPI * PEG_PRICE_USD,
  sourceUrls: ["https://docs.frax.finance/frax-price-index/fpi-controller-pool"],
};

describe("FPI Controller Pool V9 route", () => {
  it("builds an exact, tracked-output observation from accepted pinned state", () => {
    const observation = buildFpiControllerV9ExitRouteObservation({
      state: STATE,
      modeledExitSizeUsd: 1_000_000,
      routeStatus: "open",
      resolutionState: "resolved",
      now: NOW,
    });

    expect(observation).toMatchObject({
      routeId: "redemption:fpi-frax:fpi-controller:ethereum",
      routeFamily: "protocol-redemption",
      scope: {
        kind: "chain-contract",
        chain: "ethereum",
        contractOrPoolId: STATE.controllerAddress,
        protocol: "frax",
      },
      requestedNotionalUsd: 1_000_000,
      maxCostBps: 200,
      executableUsd: STATE.capacityUsd,
      completionRatio: STATE.capacityUsd / 1_000_000,
      settlementHorizonSec: 300,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["frax-frax"] },
      evidenceKind: "onchain-contract-state",
      executionCostBps: 30,
      outputUnitValueUsd: OUTPUT_PRICE_USD,
      allInCostBps: ALL_IN_COST_BPS,
      modelConfidence: "medium",
      confidence: "high",
      scoreEligible: true,
      observedAt: STATE.blockTimestamp,
      freshnessSeconds: 30,
    });
    expect(observation?.capacityCurve).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestedNotionalUsd: 100_000, completionRatio: 1 }),
        expect.objectContaining({
          requestedNotionalUsd: 1_000_000,
          executableUsd: STATE.capacityUsd,
        }),
      ]),
    );
  });

  it("keeps an accepted fact non-eligible when the route is closed or unresolved", () => {
    expect(
      buildFpiControllerV9ExitRouteObservation({
        state: STATE,
        modeledExitSizeUsd: 1_000_000,
        routeStatus: "paused",
        resolutionState: "resolved",
        now: NOW,
      })?.scoreEligible,
    ).toBe(false);
    expect(
      buildFpiControllerV9ExitRouteObservation({
        state: STATE,
        modeledExitSizeUsd: 1_000_000,
        routeStatus: "open",
        resolutionState: "missing-capacity",
        now: NOW,
      })?.scoreEligible,
    ).toBe(false);
  });

  it("does not accept rejected, malformed, or fee-drifted attempts", () => {
    expect(
      parseAcceptedFpiControllerV9RouteState({
        status: "rejected",
        attemptedAtSec: NOW,
        rejectionCode: "fee-drift",
      }),
    ).toBeNull();
    expect(
      parseAcceptedFpiControllerV9RouteState({
        status: "accepted",
        attemptedAtSec: NOW,
        state: { ...STATE, controllerCodeHash: "not-a-hash" },
      }),
    ).toBeNull();
    const overBoundOutputPriceUsd = 0.979;
    const overBoundAllInCostBps =
      (1 - (QUOTE_OUTPUT_FRAX * overBoundOutputPriceUsd) / PEG_PRICE_USD) * 10_000;
    expect(
      buildFpiControllerV9ExitRouteObservation({
        state: {
          ...STATE,
          outputPriceUsd: overBoundOutputPriceUsd,
          allInCostBps: overBoundAllInCostBps,
        },
        modeledExitSizeUsd: 1_000_000,
        routeStatus: "open",
        resolutionState: "resolved",
        now: NOW,
      }),
    ).toMatchObject({
      executableUsd: 0,
      completionRatio: 0,
      scoreEligible: false,
    });
  });
});
