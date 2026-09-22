import { describe, expect, it, vi } from "vitest";

const fetchUniV3DataMock = vi.hoisted(() => vi.fn());
const fetchUniswapV4DataMock = vi.hoisted(() => vi.fn());

vi.mock("../subgraph-source-families", () => ({
  fetchUniV3Data: fetchUniV3DataMock,
  fetchUniswapV4Data: fetchUniswapV4DataMock,
}));

import { fetchSubgraphEnrichmentPhase } from "../orchestrator-phases/subgraph-enrichment";
import type { PriceValidationReferences } from "../../../lib/price-validation";

const VALIDATION_REFERENCES: PriceValidationReferences = {
  rates: {},
  type: "none",
  updatedAt: null,
};

function runPhase() {
  return fetchSubgraphEnrichmentPhase({
    graphApiKey: "graph-key",
    symbolToChainScopedIds: new Map(),
    chainAddressToId: new Map(),
    validationReferences: VALIDATION_REFERENCES,
  });
}

function uniV3Result(failedChains: string[]) {
  return {
    uniV3PoolFees: new Map(),
    uniV3SymbolFees: new Map(),
    uniV3PriceObs: new Map(),
    uniV3ExecutionCandidates: new Map(),
    failedChains,
  };
}

describe("subgraph enrichment phase", () => {
  it("names the chains whose subgraph did not answer", async () => {
    fetchUniV3DataMock.mockResolvedValue(uniV3Result(["base", "celo"]));
    fetchUniswapV4DataMock.mockResolvedValue({
      uniswapV4ExecutionCandidates: new Map(),
      failedChains: ["bsc"],
    });

    const result = await runPhase();

    expect(result.failedSources).toEqual([
      "univ3-subgraph:base",
      "univ3-subgraph:celo",
      "uniswap-v4-subgraph:bsc",
    ]);
  });

  it("leaves failedSources clean when every chain answers, including empty ones", async () => {
    fetchUniV3DataMock.mockResolvedValue(uniV3Result([]));
    fetchUniswapV4DataMock.mockResolvedValue({
      uniswapV4ExecutionCandidates: new Map(),
      failedChains: [],
    });

    const result = await runPhase();

    expect(result.failedSources).toEqual([]);
  });
});
