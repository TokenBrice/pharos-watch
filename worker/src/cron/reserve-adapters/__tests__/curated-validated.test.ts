import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { installAdapterNetwork, type AdapterNetwork } from "./reserve-adapter.test-support";

vi.mock("@shared/lib/redemption-backstop-configs", () => ({
  REDEMPTION_BACKSTOP_CONFIGS: {
    "coin-with-open-route": { routeStatus: "open" },
    "coin-with-unknown-route": { routeStatus: "unknown" },
    "coin-without-route": {},
  },
}));

import { fetchCuratedValidatedReserves } from "../curated-validated";

let signal: AbortSignal;

const EVM_CONTRACT = "0x1111111111111111111111111111111111111111";
const SOLANA_RPC = "https://solana-rpc.example";
const SOLANA_MINT = "Mint1111111111111111111111111111111111";

function makeCoin(
  reserves?: ReserveSlice[],
  contracts?: Array<{ chain: string; address: string }>,
  id = "test-coin",
): StablecoinMeta {
  return { id, name: "Test", ticker: "TST", reserves, contracts } as unknown as StablecoinMeta;
}

const BASE_CONFIG: LiveReservesConfig = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
};

const MULTI_SLICE_RESERVES: ReserveSlice[] = [
  { name: "U.S. Treasury bills", pct: 60, risk: "very-low" },
  { name: "Cash deposits", pct: 25, risk: "very-low" },
  { name: "USDC", pct: 15, risk: "low", coinId: "usdc-circle", depType: "wrapper" },
];

const installedNetworks: AdapterNetwork[] = [];

/** Answer the supply probe at the fetch boundary: EVM `totalSupply()` and Solana `getTokenSupply`. */
function installSupplyNetwork(supply: bigint): AdapterNetwork {
  const network = installAdapterNetwork({
    rpc: { [`${EVM_CONTRACT}:totalSupply()`]: supply },
    chains: { solana: SOLANA_RPC },
    json: {
      [SOLANA_RPC]: async (request: Request) => {
        const body = await request.json() as { method?: string; params?: [string] };
        if (body.method !== "getTokenSupply") return {};
        if (body.params?.[0] !== SOLANA_MINT) return {};
        return { result: { context: { slot: 1 }, value: { amount: supply.toString(), decimals: 6, uiAmount: 1 } } };
      },
    },
  });
  installedNetworks.push(network);
  return network;
}

const scheduledCtx = (network: AdapterNetwork) => ({ chainRpcs: network.chainRpcs });

beforeEach(() => {
  signal = new AbortController().signal;
  vi.clearAllMocks();
  installedNetworks.length = 0;
});
afterEach(() => {
  // No request may leave the routing table: any unexpected URL is recorded as unmatched.
  expect(installedNetworks.map((network) => network.unmatched)).toEqual([[]]);
});

describe("fetchCuratedValidatedReserves", () => {
  it("returns coin.reserves as slices when probe succeeds", async () => {
    const network = installSupplyNetwork(1000000n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }]),
      BASE_CONFIG,
      signal,
      scheduledCtx(network),
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("1000000");
  });

  it("resolves the supply through the scheduled chain RPC context", async () => {
    const network = installSupplyNetwork(1000000n);
    const config: LiveReservesConfig = {
      ...BASE_CONFIG,
      inputs: { primary: { kind: "onchain-solana" } },
    };
    const coin = makeCoin(MULTI_SLICE_RESERVES, [{ chain: "solana", address: SOLANA_MINT }]);

    const result = await fetchCuratedValidatedReserves(coin, config, signal, scheduledCtx(network));

    expect(result.metadata?.totalSupplyRaw).toBe("1000000");
    expect(network.requests.map((request) => request.url)).toContain(`${SOLANA_RPC}/`);
  });

  it("preserves coinId and depType from curated reserves", async () => {
    const network = installSupplyNetwork(500n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }]),
      BASE_CONFIG,
      signal,
      scheduledCtx(network),
    );

    const usdcSlice = result.slices.find((s) => s.name === "USDC");
    expect(usdcSlice?.coinId).toBe("usdc-circle");
    expect(usdcSlice?.depType).toBe("wrapper");
  });

  it("throws when coin.reserves is empty", async () => {
    installSupplyNetwork(1000000n);
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin([], [{ chain: "ethereum", address: EVM_CONTRACT }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("coin.reserves to be defined and non-empty");
  });
  it("throws when coin.reserves is undefined", async () => {
    installSupplyNetwork(1000000n);
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(undefined, [{ chain: "ethereum", address: EVM_CONTRACT }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("coin.reserves to be defined and non-empty");
  });

  it("throws when the probed supply reads zero", async () => {
    const network = installSupplyNetwork(0n);

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }]),
        BASE_CONFIG,
        signal,
        scheduledCtx(network),
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });

  it("throws when probe cannot find contract", async () => {
    installSupplyNetwork(1000000n);

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "arbitrum", address: EVM_CONTRACT }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("could not find a ethereum contract");
  });

  it("supports non-EVM onchain probe paths when the helper resolves supply", async () => {
    const network = installSupplyNetwork(42n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "solana", address: SOLANA_MINT }]),
      {
        ...BASE_CONFIG,
        inputs: {
          primary: { kind: "onchain-solana" },
        },
      },
      signal,
      scheduledCtx(network),
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("42");
  });

  it("derives routeStatus 'open' from the coin's redemption-backstop config", async () => {
    const network = installSupplyNetwork(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }], "coin-with-open-route"),
      BASE_CONFIG,
      signal,
      scheduledCtx(network),
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string; routeStatusSource?: string };
    expect(redemption.routeStatus).toBe("open");
    expect(redemption.routeStatusSource).toBe("static-config");
  });

  it("falls back to routeStatus 'unknown' when the coin has no backstop config", async () => {
    const network = installSupplyNetwork(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }], "coin-unmapped"),
      BASE_CONFIG,
      signal,
      scheduledCtx(network),
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string };
    expect(redemption.routeStatus).toBe("unknown");
  });

  it("falls back to routeStatus 'unknown' when the backstop config does not specify one", async () => {
    const network = installSupplyNetwork(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }], "coin-without-route"),
      BASE_CONFIG,
      signal,
      scheduledCtx(network),
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string };
    expect(redemption.routeStatus).toBe("unknown");
  });

  it("never opens an on-chain call for a coin without redemptionCapacity params", async () => {
    const network = installSupplyNetwork(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: EVM_CONTRACT }], "coin-with-open-route"),
      BASE_CONFIG,
      signal,
      scheduledCtx(network),
    );
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-eventual",
      routeStatusSource: "static-config",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
  });
});
