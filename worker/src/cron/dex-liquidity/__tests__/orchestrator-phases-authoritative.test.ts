import { describe, expect, it } from "vitest";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
import {
  buildDexDirectApiFetchers,
  DEX_POOL_SOURCE_REGISTRY,
  type DirectApiCensusScope,
  type DirectApiFetchPhaseEntry,
} from "../orchestrator-phases/direct-api";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const ETHEREUM_POOL_KEY = "ethereum:0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea";

describe("buildAuthoritativeStagedPoolConfirmationIndex", () => {
  it("requires positive exhaustive authority even when raw identities and a healthy result exist", () => {
    const entry: DirectApiFetchPhaseEntry = {
      name: "Undeclared",
      circuitKey: "undeclared-api",
      normalizedProtocol: "undeclared",
      supportedChains: ["ethereum"],
      censusScope: "exhaustive",
      authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
      result: { pools: [], ok: true, degraded: false, errors: [] },
    };
    Reflect.deleteProperty(entry, "censusScope");
    const index = buildAuthoritativeStagedPoolConfirmationIndex([entry]);
    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("enforces confirmation on a chain where an exhaustive census legitimately found no pools", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["ethereum", "plasma"],
        censusScope: "exhaustive",
        authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.get("balancer")).toEqual(new Set(["ethereum", "plasma"]));
    expect(index.confirmedExactKeysByProtocol.get("balancer")).toEqual(new Set([ETHEREUM_POOL_KEY]));
  });

  it("enforces confirmation for warning-only authoritative protocol fetches", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["ethereum"],
        censusScope: "exhaustive",
        authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
          warnings: ["page 1 skipped 1 malformed pool rows"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.get("balancer")).toEqual(new Set(["ethereum"]));
    expect(index.confirmedExactKeysByProtocol.get("balancer")).toEqual(new Set([ETHEREUM_POOL_KEY]));
  });

  it("fails open when the authoritative fetch has a real failure", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["plasma"],
        censusScope: "exhaustive",
        authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
        result: {
          pools: [],
          ok: true,
          degraded: true,
          errors: ["partial"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("fails open when the authoritative fetch has mixed warnings and real failures", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["ethereum"],
        censusScope: "exhaustive",
        authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
        result: {
          pools: [],
          ok: true,
          degraded: true,
          errors: ["balancer page 2 returned 503"],
          warnings: ["page 1 skipped 1 malformed pool rows"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("fails open while a paginated authoritative inventory is incomplete", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "PancakeSwap",
        circuitKey: "pancakeswap-api",
        normalizedProtocol: "pancakeswap",
        supportedChains: ["bsc"],
        censusScope: "exhaustive",
        authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
          pagination: {
            state: "partial",
            headRefreshed: true,
            pagesFetched: 3,
            cursor: "750",
            cycleCompleted: false,
          },
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  // ODR-B1b `pools-lost-before-scoring`: three ways a census with no authority
  // over a staged pool was nonetheless allowed to veto it.
  it("never enforces from a bounded-sample census", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Meteora",
        circuitKey: "meteora-api",
        normalizedProtocol: "meteora",
        supportedChains: ["solana"],
        censusScope: "bounded-sample",
        authoritativeExactPoolKeys: new Set(["solana:5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"]),
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("never enforces when the census produced no identity at all", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Aerodrome Slipstream",
        circuitKey: "aerodrome-slipstream-api",
        normalizedProtocol: "aerodrome",
        supportedChains: ["base"],
        censusScope: "exhaustive",
        authoritativeExactPoolKeys: new Set<string>(),
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("never enforces from the compacted tracked-token pool list", () => {
    // `result.pools` is filtered down to tracked tokens during compaction, so it
    // must never stand in for the raw census. Without a raw key set there is
    // nothing to confirm against and the protocol must not veto.
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Orca",
        circuitKey: "orca-api",
        normalizedProtocol: "orca",
        supportedChains: ["solana"],
        censusScope: "exhaustive",
        result: {
          pools: [
            {
              source: "orca",
              chain: "solana",
              poolAddress: "2D9mokxthTheNAU6hCWGRXdNmhNQoypHs1JcRCbwkgLL",
              poolType: "orca-whirlpool",
              tokens: [
                { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, priceUsd: 100 },
                { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, priceUsd: 1 },
              ],
              price: 100,
              tvlUsd: 1_000_000,
              volume24hUsd: 0,
              feeRate: null,
              balances: null,
            },
          ],
          ok: true,
          degraded: false,
          errors: [],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });
});

describe("direct API census scope declarations", () => {
  // One matrix enrolls every registry slot's maximum authority and stop policy.
  // Completion must describe this run, never a resumed multi-run rotation.
  const contracts: { slotId: string; censusScope: DirectApiCensusScope; stop: string }[] = [
    { slotId: "fluid", censusScope: "bounded-sample", stop: "tracked-token extract" },
    { slotId: "balancer", censusScope: "exhaustive", stop: "short page; full page at cap is partial" },
    { slotId: "pancakeswap", censusScope: "bounded-sample", stop: "head plus two rotating tail pages" },
    { slotId: "meteora", censusScope: "bounded-sample", stop: "three-page head sample" },
    { slotId: "raydium-clmm", censusScope: "exhaustive", stop: "short page or below admission floor; cap is partial" },
    { slotId: "orca-clmm", censusScope: "exhaustive", stop: "four-page budget; contiguous exhausted run only" },
    { slotId: "aerodrome-slipstream", censusScope: "bounded-sample", stop: "tracked priceable reserve extract" },
    { slotId: "uniswap-v3-bsc-shadow", censusScope: "bounded-sample", stop: "bounded staged exact-pool recovery" },
    { slotId: "velodrome-slipstream", censusScope: "bounded-sample", stop: "tracked priceable reserve extract" },
  ];
  const fetchers = buildDexDirectApiFetchers({
    db: makeNoopD1(),
    graphApiKey: null,
    chainAddressToId: new Map(),
    symbolToChainScopedIds: new Map(),
    stablecoinPriceById: new Map(),
  });

  it("enrolls every registered adapter exactly once in the census contract matrix", () => {
    expect(contracts.map(({ slotId }) => slotId).sort()).toEqual(
      DEX_POOL_SOURCE_REGISTRY.map(({ slotId }) => slotId).sort(),
    );
    expect(fetchers.map(({ slotId }) => slotId).sort()).toEqual(contracts.map(({ slotId }) => slotId).sort());
  });

  it.each(contracts)("$slotId declares its $stop census contract", ({ slotId, censusScope }) => {
    const fetcher = fetchers.find((adapter) => adapter.slotId === slotId)!;
    expect(fetcher.censusScope).toBe(censusScope);
    for (const scan of ["exhausted", "capped", "later-page-failure", "malformed-identity", "resumed-tail"] as const) {
      const chain = fetcher.supportedChains[0];
      const index = buildAuthoritativeStagedPoolConfirmationIndex([{
        ...fetcher,
        authoritativeExactPoolKeys: new Set([`${chain}:pool`]),
        result: {
          pools: [], ok: true, degraded: scan === "later-page-failure", errors: [],
          physicalPoolCensus: { exactPoolKeys: [`${chain}:pool`], incompleteChains: scan === "malformed-identity" ? [chain] : [] },
          pagination: {
            state: scan === "exhausted" || scan === "malformed-identity" ? "complete" : "partial",
            headRefreshed: true, pagesFetched: 1, cursor: scan === "exhausted" ? null : "tail",
            cycleCompleted: scan === "exhausted" || scan === "malformed-identity" || scan === "resumed-tail",
          },
        },
      }]);
      expect(index.enforcedChainsByProtocol.get(fetcher.normalizedProtocol)?.has(chain) ?? false,
        `${slotId}: ${scan}`).toBe(censusScope === "exhaustive" && scan === "exhausted");
    }
  });

  it("withholds veto authority from every provider that returns a filtered extract", () => {
    const fetchers = buildDexDirectApiFetchers({
      db: makeNoopD1(),
      graphApiKey: null,
      chainAddressToId: new Map(),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map(),
    });
    const scopeByName = new Map(fetchers.map((fetcher) => [fetcher.name, fetcher.censusScope]));

    // Meteora reads ~10 of the ~123k pools its own API advertises; Fluid and the
    // two Sugar/Slipstream crawls only ever emit tracked, two-sided, priceable
    // pools. None of them can certify that an unseen pool does not exist.
    expect(scopeByName.get("Meteora")).toBe("bounded-sample");
    expect(scopeByName.get("Fluid")).toBe("bounded-sample");
    expect(scopeByName.get("Aerodrome Slipstream")).toBe("bounded-sample");
    expect(scopeByName.get("Velodrome Slipstream")).toBe("bounded-sample");
    // PancakeSwap refreshes the head page but rotates only two tail pages per
    // run, so a pool absent from one response was usually just read on an
    // earlier run; its per-run key set must never veto staged rows.
    expect(scopeByName.get("PancakeSwap")).toBe("bounded-sample");
  });
});
