import { describe, expect, it } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import {
  DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
  buildDexPlaceholderScoreDetailsJson,
  classifyDexPlaceholderCoverage,
  type DexDeploymentCensusRow,
} from "../deployment-census-coverage";

const NOW_SEC = 1_800_000_000;

function deployment(
  chain = "ethereum",
  address = "0x0000000000000000000000000000000000000001",
): ContractDeployment {
  return { chain, address, decimals: 18 };
}

function outcome(
  overrides: Partial<DexDeploymentCensusRow> = {},
): DexDeploymentCensusRow {
  return {
    stablecoin_id: "test",
    chain: "ethereum",
    contract_address: "0x0000000000000000000000000000000000000001",
    outcome: "verified_no_pools",
    provider_set_json: JSON.stringify(["coingecko"]),
    reason: "A provider completed the direct-token query with no eligible pool",
    observed_pool_count: 0,
    observed_at: NOW_SEC - 60,
    discovery_last_crawl_at: NOW_SEC - 120,
    ...overrides,
  };
}

describe("DEX placeholder deployment-census coverage", () => {
  it("publishes populated 0/0 only for a complete fresh reviewed-empty scope", () => {
    const classification = classifyDexPlaceholderCoverage({
      deployments: [
        deployment(),
        deployment("base", "0x0000000000000000000000000000000000000002"),
      ],
      outcomeRows: [
        outcome(),
        outcome({
          chain: "base",
          contract_address: "0x0000000000000000000000000000000000000002",
        }),
      ],
      nowSec: NOW_SEC,
    });

    expect(classification).toEqual({
      state: "complete-empty",
      coverage: {
        status: "populated",
        capabilityMatrixVersion: "p4a.8",
        retainedPoolCount: 0,
        observationCount: 0,
        scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0,
        scoreEligibleCapabilityPoolCount: 0,
        unsupportedPoolCount: 0,
        evidenceCounts: {},
        unsupportedReasons: {},
      },
      census: {
        expectedDeploymentCount: 2,
        reviewedDeploymentCount: 2,
        verifiedNoPoolsCount: 2,
        observedPoolsCount: 0,
        providerInaccessibleCount: 0,
        missingOutcomeCount: 0,
        staleOutcomeCount: 0,
        supersededOutcomeCount: 0,
        invalidOutcomeCount: 0,
        oldestObservedAtSec: NOW_SEC - 60,
        newestObservedAtSec: NOW_SEC - 60,
        maxAgeSec: DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
        reasonCounts: {},
      },
    });

    expect(
      JSON.parse(
        buildDexPlaceholderScoreDetailsJson({
          classification,
          generationId: "dex-liquidity-test",
          publishedAtSec: NOW_SEC,
        }),
      ),
    ).toMatchObject({
      exitRouteObservations: [],
      exitRouteObservationCoverage: {
        status: "populated",
        retainedPoolCount: 0,
        observationCount: 0,
      },
      dexDeploymentCensus: {
        schemaVersion: 1,
        state: "complete-empty",
        generationId: "dex-liquidity-test",
        publishedAtSec: NOW_SEC,
        expectedDeploymentCount: 2,
      },
    });
  });

  it.each([
    {
      name: "missing exact deployment outcome",
      deployments: [deployment(), deployment("base", "0x2")],
      rows: [outcome()],
      state: "discovery-deferral",
      reason: "deploymentCensusMissingOutcome",
    },
    {
      name: "stale reviewed outcome",
      deployments: [deployment()],
      rows: [
        outcome({
          observed_at: NOW_SEC - DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC - 1,
        }),
      ],
      state: "discovery-deferral",
      reason: "deploymentCensusStaleOutcome",
    },
    {
      name: "successful outcome superseded by a later failed crawl",
      deployments: [deployment()],
      rows: [
        outcome({
          discovery_last_crawl_at: NOW_SEC - 30,
        }),
      ],
      state: "discovery-deferral",
      reason: "deploymentCensusSupersededOutcome",
    },
    {
      name: "successful outcome without discovery-attempt provenance",
      deployments: [deployment()],
      rows: [
        outcome({
          discovery_last_crawl_at: null,
        }),
      ],
      state: "validation-failure",
      reason: "deploymentCensusInvalidOutcome",
    },
    {
      name: "successful outcome with future discovery-attempt provenance",
      deployments: [deployment()],
      rows: [
        outcome({
          discovery_last_crawl_at: NOW_SEC + 1,
        }),
      ],
      state: "validation-failure",
      reason: "deploymentCensusInvalidOutcome",
    },
    {
      name: "provider outage",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "provider_inaccessible",
          observed_pool_count: 0,
          provider_set_json: JSON.stringify(["coingecko"]),
        }),
      ],
      state: "provider-outage",
      reason: "deploymentCensusProviderOutage",
    },
    {
      name: "unsupported provider method",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "provider_inaccessible",
          observed_pool_count: 0,
          provider_set_json: "[]",
        }),
      ],
      state: "unsupported-method",
      reason: "deploymentCensusUnsupportedMethod",
    },
    {
      name: "observed pool lost before scoring",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "observed_pools",
          observed_pool_count: 1,
        }),
      ],
      state: "pools-lost-before-scoring",
      reason: "deploymentCensusObservedPoolsWithoutScoredPool",
    },
    {
      name: "malformed successful outcome",
      deployments: [deployment()],
      rows: [outcome({ provider_set_json: "{bad" })],
      state: "validation-failure",
      reason: "deploymentCensusInvalidOutcome",
    },
    {
      name: "unregistered provider identity",
      deployments: [deployment()],
      rows: [outcome({ provider_set_json: JSON.stringify(["bogus"]) })],
      state: "validation-failure",
      reason: "deploymentCensusInvalidOutcome",
    },
    {
      name: "unknown outcome value",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "corrupt" as DexDeploymentCensusRow["outcome"],
        }),
      ],
      state: "validation-failure",
      reason: "deploymentCensusInvalidOutcome",
    },
    {
      name: "observed outcome without a provider",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "observed_pools",
          observed_pool_count: 1,
          provider_set_json: "[]",
        }),
      ],
      state: "validation-failure",
      reason: "deploymentCensusInvalidOutcome",
    },
  ])("fails closed for $name", ({ deployments, rows, state, reason }) => {
    const classification = classifyDexPlaceholderCoverage({
      deployments,
      outcomeRows: rows,
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe(state);
    expect(classification.coverage.status).toBe("unknown");
    expect(classification.coverage.unsupportedReasons[reason]).toBeGreaterThan(0);
  });

  it("does not mistake a case-folded native row for the current deployment", () => {
    const exactAddress = "SoLaNaCaseSensitiveMint";
    const classification = classifyDexPlaceholderCoverage({
      deployments: [deployment("solana", exactAddress)],
      outcomeRows: [
        outcome({
          chain: "solana",
          contract_address: exactAddress.toLowerCase(),
        }),
      ],
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("discovery-deferral");
    expect(classification.census).toMatchObject({
      expectedDeploymentCount: 1,
      reviewedDeploymentCount: 0,
      missingOutcomeCount: 1,
    });
  });

  it("keeps unavailable and unreviewed censuses explicit unknown", () => {
    const unavailable = classifyDexPlaceholderCoverage({
      deployments: [deployment()],
      outcomeRows: [],
      nowSec: NOW_SEC,
      censusAvailable: false,
    });
    const unreviewed = classifyDexPlaceholderCoverage({
      deployments: [],
      outcomeRows: [],
      nowSec: NOW_SEC,
    });

    expect(unavailable).toMatchObject({
      state: "discovery-deferral",
      coverage: {
        status: "unknown",
        unsupportedReasons: { deploymentCensusUnavailable: 1 },
      },
    });
    expect(unreviewed).toMatchObject({
      state: "unsupported-method",
      coverage: {
        status: "unknown",
        unsupportedReasons: { deploymentCensusNoReviewedScope: 1 },
      },
    });
  });
});
