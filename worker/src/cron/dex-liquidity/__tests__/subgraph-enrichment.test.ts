import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const fetchUniV3DataMock = vi.hoisted(() => vi.fn());
const fetchUniswapV4DataMock = vi.hoisted(() => vi.fn());

vi.mock("../subgraph-source-families", () => ({
  fetchUniV3Data: fetchUniV3DataMock,
  fetchUniswapV4Data: fetchUniswapV4DataMock,
}));

import { fetchSubgraphEnrichmentPhase } from "../orchestrator-phases/subgraph-enrichment";
import { UNIV3_SUBGRAPHS } from "../constants";
import { buildUniV3ExecutionCandidateKey } from "../../measured-execution/inventory";
import type { UniV3ExecutionCandidate } from "../../measured-execution/candidate-types";
import type { PriceValidationReferences } from "../../../lib/price-validation";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const VALIDATION_REFERENCES: PriceValidationReferences = {
  rates: {},
  type: "none",
  updatedAt: null,
};
const NOW = 1_791_573_008;
const EURC = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETH_POOL: UniV3ExecutionCandidate = {
  chain: "ethereum",
  poolAddress: "0x95dbb3c7546f22bce375900abfdd64a4e5bd73d6",
  feePips: 500,
  tvlUsd: 2_500_000,
  token0Price: 1.08,
  token1Price: 0.925,
  tokens: [{ address: EURC, symbol: "EURC", decimals: 6 }, { address: USDC, symbol: "USDC", decimals: 6 }],
};
const ETH_KEY = buildUniV3ExecutionCandidateKey("ethereum", [EURC, USDC], 500)!;

function runPhase(db: D1Database, graphApiKey: string | null = "graph-key") {
  return fetchSubgraphEnrichmentPhase({
    db,
    nowSec: NOW,
    graphApiKey,
    symbolToChainScopedIds: new Map(),
    chainAddressToId: new Map(),
    uniswapV4ExactPoolIdsByChain: new Map(),
    validationReferences: VALIDATION_REFERENCES,
  });
}

function uniV3Result(failedChains: string[], candidates: UniV3ExecutionCandidate[] = []) {
  const uniV3ExecutionCandidates = new Map<string, UniV3ExecutionCandidate[]>();
  for (const candidate of candidates) {
    const key = buildUniV3ExecutionCandidateKey(candidate.chain, candidate.tokens.map((token) => token.address), candidate.feePips)!;
    uniV3ExecutionCandidates.set(key, [...(uniV3ExecutionCandidates.get(key) ?? []), candidate]);
  }
  return {
    uniV3PoolFees: new Map(),
    uniV3SymbolFees: new Map(),
    uniV3PriceObs: new Map(),
    uniV3ExecutionCandidates,
    failedChains,
  };
}

const V4_CLEAN = { uniswapV4ExecutionCandidates: new Map(), failedChains: [] };

describe("subgraph enrichment phase", () => {
  it("names the chains whose subgraph did not answer", async () => {
    fetchUniV3DataMock.mockResolvedValue(uniV3Result(["base", "celo"]));
    fetchUniswapV4DataMock.mockResolvedValue({
      uniswapV4ExecutionCandidates: new Map(),
      failedChains: ["bsc"],
    });

    const result = await runPhase(fixtures.open().db);

    expect(result.failedSources).toEqual([
      "univ3-subgraph:base",
      "univ3-subgraph:celo",
      "uniswap-v4-subgraph:bsc",
    ]);
  });

  it("leaves failedSources clean when every chain answers, including empty ones", async () => {
    fetchUniV3DataMock.mockResolvedValue(uniV3Result([]));
    fetchUniswapV4DataMock.mockResolvedValue(V4_CLEAN);

    const result = await runPhase(fixtures.open().db);

    expect(result.failedSources).toEqual([]);
    expect(result.uniV3CandidateCarryForward).toEqual(
      Object.keys(UNIV3_SUBGRAPHS).map((chain) => ({ chain, outcome: "persisted", candidates: 0 })),
    );
  });

  it("carries the previous run's candidates into a chain that failed this run and keeps the source failed", async () => {
    const { db } = fixtures.open();
    fetchUniswapV4DataMock.mockResolvedValue(V4_CLEAN);
    fetchUniV3DataMock.mockResolvedValueOnce(uniV3Result([], [ETH_POOL]));
    await runPhase(db);

    fetchUniV3DataMock.mockResolvedValueOnce(uniV3Result(["ethereum"]));
    const result = await runPhase(db);

    expect(result.failedSources).toEqual(["univ3-subgraph:ethereum"]);
    expect(result.uniV3ExecutionCandidates.get(ETH_KEY)).toEqual([ETH_POOL]);
    expect(result.uniV3CandidateCarryForward).toContainEqual({
      chain: "ethereum", outcome: "carried", fetchedAt: NOW, ageSec: 0, candidates: 1, added: 1,
    });
  });

  it("treats a thrown family fetch as every chain failed and still carries", async () => {
    const { db } = fixtures.open();
    fetchUniswapV4DataMock.mockResolvedValue(V4_CLEAN);
    fetchUniV3DataMock.mockResolvedValueOnce(uniV3Result([], [ETH_POOL]));
    await runPhase(db);

    fetchUniV3DataMock.mockRejectedValueOnce(new Error("gateway down"));
    const result = await runPhase(db);

    expect(result.failedSources).toEqual(["univ3-subgraph"]);
    expect(result.uniV3ExecutionCandidates.get(ETH_KEY)).toEqual([ETH_POOL]);
    expect(result.uniV3CandidateCarryForward.map((entry) => entry.outcome)).toEqual(
      Object.keys(UNIV3_SUBGRAPHS).map(() => "carried"),
    );
  });

  it("neither reads nor writes snapshots without a Graph key", async () => {
    fetchUniV3DataMock.mockResolvedValue(uniV3Result([]));
    fetchUniswapV4DataMock.mockResolvedValue(V4_CLEAN);

    const result = await runPhase(makeNoopD1(), null);

    expect(result.uniV3CandidateCarryForward).toEqual([]);
  });
});
