import { describe, expect, it } from "vitest";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input-core";
import { makeV9Extension } from "../../test-helpers/v9-fixed-input-extensions";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { computeDexDeploymentSupplyCoverage } from "../report-cards-snapshot-inputs";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";

const ethereum = { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", decimals: 18 };
const base = { chain: "base", address: "0x2222222222222222222222222222222222222222", decimals: 18 };
const point = (current: number) => ({ current, circulatingPrevDay: current, circulatingPrevWeek: current, circulatingPrevMonth: current });

describe("exhaustive DEX exit census admission", () => {
  it.each(["partial", "omitted-deployment", "unavailable-aggregate", "legacy-subtotal", "overlapping-raw", "complete", "verified-zero-deployment", "stale-empty"] as const)(
    "requires aggregate-reconciled deployment coverage before global empty exit: %s", (scenario) => {
      const complete = scenario === "complete" || scenario === "verified-zero-deployment";
      const chainCirculating = { ethereum: point(scenario === "partial" || scenario === "legacy-subtotal" ? 60 : scenario === "overlapping-raw" ? 120 : 100),
        ...(scenario === "verified-zero-deployment" ? { base: point(0) } : {}) };
      const draft = makeV9FixedInput({ aggregateCirculating: { peggedUSD: 100 }, chainSupplyByChain: chainCirculating,
        dexOverrides: { exitRouteObservations: [], exitRouteObservationCoverage: {
          status: "populated", capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
          retainedPoolCount: 0, observationCount: 0, scoreEligibleObservationCount: 0,
          scoreEligiblePoolCount: 0, unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {},
        } } });
      if (scenario === "unavailable-aggregate") draft.aggregateCirculatingById.alpha!.circulating = {};
      if (scenario === "stale-empty") {
        const updatedAt = draft.clockSec - 5_000;
        draft.dexLiqMap.alpha!.updatedAt = updatedAt;
        draft.dexGenerationId = `dex-liquidity-${updatedAt}`;
        draft.inputFreshness.dexLiquidity = {
          ...draft.inputFreshness.dexLiquidity, updatedAt, ageSeconds: draft.clockSec - updatedAt,
        };
      }
      const coverage = computeDexDeploymentSupplyCoverage({
        circulating: draft.aggregateCirculatingById.alpha!.circulating, chainCirculating,
        contracts: scenario === "complete" || scenario === "stale-empty" || scenario === "unavailable-aggregate" ? [ethereum] : [ethereum, base],
      }, [{ chain: ethereum.chain, contractAddress: ethereum.address, outcome: "verified_no_pools", observedAt: draft.clockSec }],
      new Map(), { asOfSec: draft.clockSec, maxOutcomeAgeSec: 1800 });
      if (coverage) draft.dexDeploymentSupplyCoverageById.alpha = coverage;
      else delete draft.dexDeploymentSupplyCoverageById.alpha;
      if (scenario === "partial") expect(coverage).toMatchObject({ totalSupplyUsd: 100, unknownSupplyUsd: 40,
        verifiedNoPoolsSupplyRatio: 0.6, unknownChains: ["base"] });
      if (scenario === "omitted-deployment") expect(coverage?.unknownChains).toEqual(["base"]);
      if (scenario === "unavailable-aggregate" || scenario === "overlapping-raw") expect(coverage).toBeNull();
      if (scenario === "legacy-subtotal") draft.dexDeploymentSupplyCoverageById.alpha = {
        totalSupplyUsd: 60, verifiedNoPoolsSupplyUsd: 60, verifiedNoPoolsSupplyRatio: 1,
        observedSupplyUsd: 0, observedSupplyRatio: 0, providerInaccessibleSupplyUsd: 0,
        providerInaccessibleSupplyRatio: 0, unknownSupplyUsd: 0, unknownSupplyRatio: 0, unknownChains: [],
      };
      const fixed = rebuildFixed(draft);
      const extension = makeV9Extension({ clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
      extension.assets[0]!.routeReviews = [];
      const result = buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec });
      expect(result.quarantines).toEqual([]);
      const asset = result.compiledFacts.assets[0]!;
      const card = result.candidate.cards[0]!;
      expect(asset.exitStatus.observationState).toBe(complete ? "known" : scenario === "stale-empty" ? "stale" : "bounded-unknown");
      if (complete) {
        expect(card.pillars.exit.score).toBe(0);
        expect(card.reasonCodes).toContain("no-viable-exit-path");
      } else {
        expect(card.reasonCodes).not.toContain("no-viable-exit-path");
        expect(card.scoreTrace.adverseAttribution.items.some((item) => item.path.startsWith("pillar:exit"))).toBe(false);
      }
    },
  );
});
