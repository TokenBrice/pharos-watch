import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { buildChainRpcs, type ChainRpcConfig } from "../../../../lib/chain-registry";
import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap } from "../onchain-supply";

const DWELLIR_TEST_KEY = "supply-rpc-test-key";
const ROBINHOOD_DWELLIR = "https://api-robinhood-mainnet-archive.n.dwellir.com";
const REGISTRY_PRIMARY = "https://supply-primary.example";
const REGISTRY_FALLBACK = "https://supply-fallback.example";

function supplyResponse(shares: bigint): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: `0x${(shares * 10n ** 18n).toString(16).padStart(64, "0")}`,
  }), { headers: { "Content-Type": "application/json" } });
}

function registryEndpoint(url: string): ChainRpcConfig["endpoints"][number] {
  return { url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" };
}

function keyedChainRpcs(): Map<string, ChainRpcConfig> {
  return buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_TEST_KEY });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supplemental on-chain supply RPC routing", () => {
  it("admits a supply row from a keyed supplemental-only chain", async () => {
    const chainRpcs = keyedChainRpcs();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== ROBINHOOD_DWELLIR || new Headers(init?.headers).get("X-Api-Key") !== DWELLIR_TEST_KEY) {
        return new Response("RPC authentication required", { status: 401 });
      }
      return supplyResponse(100n);
    }));

    await expect(fetchOnChainMcap(TRACKED_META_BY_ID.get("steakusdg-steakhouse")!, 1.25, chainRpcs))
      .resolves.toMatchObject({
        mcap: 125,
        supplySource: "onchain-total-supply",
        chain: "robinhood",
        chainCirculating: { "Robinhood Chain": { current: 125, chainId: "robinhood" } },
      });
  });

  it.each([false, true])("keeps registry prices ahead of supplemental RPCs (primary unavailable: %s)", async (primaryUnavailable) => {
    const chainRpcs = keyedChainRpcs();
    const ethereum = chainRpcs.get("ethereum")!;
    ethereum.endpoints = [
      registryEndpoint(REGISTRY_PRIMARY),
      registryEndpoint(REGISTRY_FALLBACK),
      ...ethereum.endpoints.filter((endpoint) => endpoint.position === "supplemental"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === REGISTRY_PRIMARY && primaryUnavailable) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      }
      return supplyResponse(url === REGISTRY_PRIMARY ? 100n : url === REGISTRY_FALLBACK ? 200n : 999n);
    }));
    const meta: StablecoinMeta = {
      ...TRACKED_META_BY_ID.get("steakusdg-steakhouse")!,
      contracts: [{ chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
    };

    await expect(fetchOnChainMcap(meta, 1.25, chainRpcs)).resolves.toMatchObject({
      mcap: primaryUnavailable ? 250 : 125,
      chain: "ethereum",
    });
  });

  it("preserves the reviewed curated supply pin ahead of unrelated registry endpoints", async () => {
    const chainRpcs = keyedChainRpcs();
    const hyperevm = chainRpcs.get("hyperevm")!;
    hyperevm.endpoints = [registryEndpoint(REGISTRY_PRIMARY), ...hyperevm.endpoints];
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      supplyResponse(url === "https://rpc.hyperliquid.xyz/evm" ? 300n : 999n),
    ));

    await expect(fetchCuratedAggregateOnChainMcap(TRACKED_META_BY_ID.get("hbusdt-hyperbeat")!, 1.25, chainRpcs))
      .resolves.toMatchObject({
        mcap: 375,
        chainCirculating: { HyperEVM: { current: 375, chainId: "hyperevm" } },
      });
  });
});
