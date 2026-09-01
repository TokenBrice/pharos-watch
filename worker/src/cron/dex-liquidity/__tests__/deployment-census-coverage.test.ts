import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment } from "@shared/types/core";
import {
  DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
  buildDexPlaceholderScoreDetailsJson,
  classifyDexPlaceholderCoverage,
  resolveDexDeploymentCensusMaxAgeSec,
  type DexDeploymentCensusRow,
} from "../deployment-census-coverage";
import {
  DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC,
  estimateDiscoverySweepWindowCount,
} from "../../dex-discovery/target-window";

const NOW_SEC = 1_800_000_000;

/** A footprint whose 2s-paced GeckoTerminal tail cannot fit one per-coin budget. */
const OVERSIZED_FOOTPRINT: ContractDeployment[] = [
  "ethereum",
  "arbitrum",
  "base",
  "optimism",
  "polygon",
  "avalanche",
  "bsc",
  "linea",
  "scroll",
  "mantle",
  "mode",
  "manta",
  "zksync",
  "sonic",
  "taiko",
  "unichain",
].map((chain, index) => ({
  chain,
  address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
  decimals: 18,
}));

/** Registry coins the discovery crawl can only sweep across several runs. */
function windowedActiveCoins(): { id: string; deployments: ContractDeployment[] }[] {
  return ACTIVE_STABLECOINS.map((meta) => ({
    id: meta.id,
    deployments: [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])],
  })).filter(({ deployments }) => estimateDiscoverySweepWindowCount(deployments) > 1);
}

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
        capabilityMatrixVersion: "p4a.9",
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
        unsupportedChainDeploymentCount: 0,
        unsupportedChains: [],
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
      name: "retryable inaccessible crawl miss is a deferral",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "provider_inaccessible",
          observed_pool_count: 0,
          provider_set_json: JSON.stringify(["geckoterminal", "dexscreener"]),
          reason: "No provider completed a query for this deployment in the bounded crawl",
        }),
      ],
      state: "discovery-deferral",
      reason: "deploymentCensusMissingOutcome",
    },
    {
      name: "pre-coverage empty provider set contradicted by the live registry",
      deployments: [deployment()],
      rows: [
        outcome({
          outcome: "provider_inaccessible",
          observed_pool_count: 0,
          provider_set_json: "[]",
          reason: "No registered token-pool provider supports this chain",
        }),
      ],
      state: "discovery-deferral",
      reason: "deploymentCensusSupersededOutcome",
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

  it("reports an unsupported-chain remainder without poisoning the reviewed scope", () => {
    const classification = classifyDexPlaceholderCoverage({
      deployments: [
        deployment(),
        deployment("secret", "secret1unsupported"),
        deployment("tezos", "KT1TEZOSASSET"),
      ],
      outcomeRows: [outcome()],
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("complete-empty");
    expect(classification.coverage).toMatchObject({
      status: "populated",
      retainedPoolCount: 0,
      unsupportedPoolCount: 0,
      unsupportedReasons: { deploymentCensusUnsupportedMethod: 2 },
    });
    expect(classification.census).toMatchObject({
      expectedDeploymentCount: 3,
      reviewedDeploymentCount: 3,
      verifiedNoPoolsCount: 1,
      providerInaccessibleCount: 2,
      missingOutcomeCount: 0,
      unsupportedChainDeploymentCount: 2,
      unsupportedChains: ["secret", "tezos"],
    });
  });

  it("accepts Horizon as the registered provider for an exact Stellar outcome", () => {
    const address = "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
    const classification = classifyDexPlaceholderCoverage({
      deployments: [deployment("stellar", address)],
      outcomeRows: [
        outcome({
          chain: "stellar",
          contract_address: address,
          provider_set_json: JSON.stringify(["horizon"]),
        }),
      ],
      nowSec: NOW_SEC,
    });

    expect(classification).toMatchObject({
      state: "complete-empty",
      census: {
        expectedDeploymentCount: 1,
        reviewedDeploymentCount: 1,
        verifiedNoPoolsCount: 1,
        unsupportedChainDeploymentCount: 0,
        unsupportedChains: [],
      },
    });
  });

  it("treats a Stellar Soroban identity as unsupported method rather than provider outage", () => {
    const address = "CDE57N6XTUPBKYYDGQMXX7E7SLNOLFY3JEQB4MULSMR2AKTSAENGX2HC";
    const classification = classifyDexPlaceholderCoverage({
      deployments: [deployment("stellar", address)],
      outcomeRows: [],
      nowSec: NOW_SEC,
    });

    expect(classification).toMatchObject({
      state: "unsupported-method",
      coverage: {
        status: "unknown",
        unsupportedReasons: { deploymentCensusUnsupportedMethod: 1 },
      },
      census: {
        expectedDeploymentCount: 1,
        reviewedDeploymentCount: 1,
        providerInaccessibleCount: 1,
        unsupportedChainDeploymentCount: 1,
        unsupportedChains: ["stellar"],
      },
    });
  });

  it("keeps a completed-empty non-exhaustive census fail-closed", () => {
    const address = "CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A";
    const classification = classifyDexPlaceholderCoverage({
      deployments: [deployment("stellar", address)],
      outcomeRows: [
        outcome({
          chain: "stellar",
          contract_address: address,
          outcome: "provider_inaccessible",
          provider_set_json: JSON.stringify(["aquarius"]),
          reason: "Provider census is not exhaustive for this chain",
        }),
      ],
      nowSec: NOW_SEC,
    });

    expect(classification).toMatchObject({
      state: "provider-outage",
      coverage: {
        status: "unknown",
        unsupportedReasons: { deploymentCensusProviderOutage: 1 },
      },
      census: {
        expectedDeploymentCount: 1,
        reviewedDeploymentCount: 1,
        verifiedNoPoolsCount: 0,
        providerInaccessibleCount: 1,
      },
    });
  });

  it("never reports an unsupported method for a deployment the registry now covers", () => {
    // The exact Spiko shape: the Soroban row was written by the static
    // inaccessible pass minutes before Aquarius coverage shipped, and the
    // windowed crawl has not rotated back to Stellar since.
    const address = "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX";
    const classification = classifyDexPlaceholderCoverage({
      deployments: [deployment(), deployment("stellar", address)],
      outcomeRows: [
        outcome(),
        outcome({
          chain: "stellar",
          contract_address: address,
          outcome: "provider_inaccessible",
          provider_set_json: "[]",
          reason: "No registered token-pool provider supports this chain",
        }),
      ],
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("discovery-deferral");
    expect(classification.coverage.status).toBe("unknown");
    expect(classification.coverage.unsupportedReasons).toEqual({
      deploymentCensusSupersededOutcome: 1,
    });
    expect(
      classification.coverage.unsupportedReasons.deploymentCensusUnsupportedMethod ?? 0,
    ).toBe(0);
    expect(classification.census.supersededOutcomeCount).toBe(1);
    expect(classification.census.unsupportedChainDeploymentCount).toBe(0);
  });

  it("keeps an entirely unsupported footprint poisoned under the same reason key", () => {
    const classification = classifyDexPlaceholderCoverage({
      deployments: [deployment("secret", "secret1unsupported")],
      outcomeRows: [],
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("unsupported-method");
    expect(classification.coverage.status).toBe("unknown");
    expect(classification.coverage.unsupportedReasons).toEqual({
      deploymentCensusUnsupportedMethod: 1,
    });
  });

  it("still fails closed when a provider-supported chain is unreviewed", () => {
    const classification = classifyDexPlaceholderCoverage({
      deployments: [
        deployment(),
        deployment("secret", "secret1unsupported"),
      ],
      outcomeRows: [],
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("discovery-deferral");
    expect(classification.coverage.status).toBe("unknown");
    expect(classification.coverage.unsupportedReasons).toEqual({
      deploymentCensusUnsupportedMethod: 1,
      deploymentCensusMissingOutcome: 1,
    });
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

  it("judges a windowed footprint against its own sweep period", () => {
    // Older than the global bound, younger than this footprint's sweep bound.
    const ageSec = DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC + 3_600;
    expect(resolveDexDeploymentCensusMaxAgeSec(OVERSIZED_FOOTPRINT)).toBeGreaterThan(ageSec);

    const rows = OVERSIZED_FOOTPRINT.map((deployed) =>
      outcome({
        chain: deployed.chain,
        contract_address: deployed.address,
        observed_at: NOW_SEC - ageSec,
        discovery_last_crawl_at: NOW_SEC - ageSec - 60,
      }),
    );
    const windowed = classifyDexPlaceholderCoverage({
      deployments: OVERSIZED_FOOTPRINT,
      outcomeRows: rows,
      nowSec: NOW_SEC,
    });

    expect(windowed.state).toBe("complete-empty");
    expect(windowed.census).toMatchObject({
      staleOutcomeCount: 0,
      maxAgeSec: resolveDexDeploymentCensusMaxAgeSec(OVERSIZED_FOOTPRINT),
    });

    // The same row age on a footprint one crawl finishes is still stale.
    const singleRun = classifyDexPlaceholderCoverage({
      deployments: [OVERSIZED_FOOTPRINT[0]!],
      outcomeRows: [rows[0]!],
      nowSec: NOW_SEC,
    });

    expect(singleRun.state).toBe("discovery-deferral");
    expect(singleRun.census).toMatchObject({
      staleOutcomeCount: 1,
      maxAgeSec: DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
    });
  });

  it("attributes a rotating attempt only to the deployment in that window", () => {
    const latestFence = NOW_SEC - 60;
    const rows = OVERSIZED_FOOTPRINT.map((deployed, index) =>
      outcome({
        chain: deployed.chain,
        contract_address: deployed.address,
        observed_at: latestFence - 1,
        discovery_last_crawl_at: latestFence,
        deployment_last_attempt_at: index === 0 ? latestFence : latestFence - 1,
        deployment_fence_attribution_at: latestFence,
      }),
    );
    const classification = classifyDexPlaceholderCoverage({
      deployments: OVERSIZED_FOOTPRINT,
      outcomeRows: rows,
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("discovery-deferral");
    expect(classification.census).toMatchObject({
      expectedDeploymentCount: OVERSIZED_FOOTPRINT.length,
      reviewedDeploymentCount: OVERSIZED_FOOTPRINT.length - 1,
      supersededOutcomeCount: 1,
      staleOutcomeCount: 0,
    });
    expect(classification.coverage.unsupportedReasons).toEqual({
      deploymentCensusSupersededOutcome: 1,
    });
  });

  it("falls back to the coin fence when a legacy writer advances it", () => {
    const legacyFence = NOW_SEC - 30;
    const rows = OVERSIZED_FOOTPRINT.map((deployed) =>
      outcome({
        chain: deployed.chain,
        contract_address: deployed.address,
        observed_at: legacyFence - 1,
        discovery_last_crawl_at: legacyFence,
        deployment_last_attempt_at: legacyFence - 1,
        deployment_fence_attribution_at: legacyFence - 60,
      }),
    );
    const classification = classifyDexPlaceholderCoverage({
      deployments: OVERSIZED_FOOTPRINT,
      outcomeRows: rows,
      nowSec: NOW_SEC,
    });

    expect(classification.state).toBe("discovery-deferral");
    expect(classification.census).toMatchObject({
      reviewedDeploymentCount: 0,
      supersededOutcomeCount: OVERSIZED_FOOTPRINT.length,
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

describe("resolveDexDeploymentCensusMaxAgeSec", () => {
  it("keeps the global bound for footprints one crawl finishes", () => {
    expect(resolveDexDeploymentCensusMaxAgeSec([])).toBe(DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC);
    expect(
      resolveDexDeploymentCensusMaxAgeSec([
        deployment(),
        deployment("base", "0x0000000000000000000000000000000000000002"),
      ]),
    ).toBe(DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC);
  });

  it("allows a windowed footprint one estimated sweep plus half a sweep of slack", () => {
    const windows = estimateDiscoverySweepWindowCount(OVERSIZED_FOOTPRINT);
    expect(windows).toBeGreaterThan(1);

    const bound = resolveDexDeploymentCensusMaxAgeSec(OVERSIZED_FOOTPRINT);
    expect(bound).toBe(Math.ceil(windows * DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC * 1.5));
    expect(bound).toBeGreaterThan(DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC);
  });

  it("never shrinks as a footprint grows", () => {
    let previous = 0;
    for (let length = 0; length <= OVERSIZED_FOOTPRINT.length; length++) {
      const bound = resolveDexDeploymentCensusMaxAgeSec(OVERSIZED_FOOTPRINT.slice(0, length));
      expect(bound).toBeGreaterThanOrEqual(previous);
      previous = bound;
    }
  });

  it("extends the bound for every tracked coin the crawl has to window", () => {
    const windowed = windowedActiveCoins();
    expect(windowed.length).toBeGreaterThan(0);

    for (const coin of windowed) {
      expect(resolveDexDeploymentCensusMaxAgeSec(coin.deployments)).toBeGreaterThan(
        DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
      );
    }
  });
});
