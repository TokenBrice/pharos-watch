import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { ChainRpcConfig } from "../../../lib/chain-registry";

const getChainRpcMock = vi.fn();
const fetchWithRetryMock = vi.fn();

vi.mock("../../../lib/chain-registry", () => ({
  getChainRpc: getChainRpcMock,
}));

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const testChainRpcs = new Map<string, ChainRpcConfig>([
  ["ethereum", {
    chainId: "ethereum",
    chainName: "Ethereum",
    type: "evm",
    rpcUrl: "https://rpc.example",
    explorerUrl: "https://etherscan.io",
  }],
]);

const JTRSY_VAULT = "0x8c213ee79581ff4984583c6a801e5263418c4b86";
const USDC_ASSET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function makeCoin(): StablecoinMeta {
  // Minimal synthetic meta — adapter only reads id + contracts.
  return {
    id: "jtrsy-anemoy",
    name: "Janus Henderson Anemoy Treasury Fund",
    symbol: "JTRSY",
    contracts: [
      { chain: "ethereum", address: JTRSY_VAULT, decimals: 6 },
    ],
  } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "centrifuge-vault",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" },
    },
    params: {
      assetAddress: USDC_ASSET,
      slice: {
        name: "U.S. Treasury bills via Janus Henderson Anemoy fund",
        risk: "very-low",
      },
    },
  };
}

describe("fetchCentrifugeVaultReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChainRpcMock.mockImplementation((_chainRpcs: Map<string, unknown>, chainId: string) =>
      testChainRpcs.get(chainId),
    );
  });

  it("returns a single 100% T-bill slice after probing the ERC-7540 vault", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      return null;
    });

    const { fetchCentrifugeVaultReserves } = await import("../centrifuge-vault");

    const result = await fetchCentrifugeVaultReserves(
      makeCoin(),
      makeConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      {
        name: "U.S. Treasury bills via Janus Henderson Anemoy fund",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      contractAddress: JTRSY_VAULT,
      assetAddress: USDC_ASSET,
      totalAssetsRaw: "100",
      totalSupplyRaw: "100",
      convertToAssetsRaw: "100",
      collateralizationRatio: 1,
      details: {
        proofKind: "centrifuge-vault-total-assets",
        assetAddressMatchesExpected: true,
      },
      redemption: {
        capacityKind: "documented-eventual",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
  });

  it("throws when asset() returns a different token than configured", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000000000000000000000000000000000000000dead",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      }
      return null;
    });

    const { fetchCentrifugeVaultReserves } = await import("../centrifuge-vault");

    await expect(
      fetchCentrifugeVaultReserves(
        makeCoin(),
        makeConfig(),
        new AbortController().signal,
        { chainRpcs: testChainRpcs },
      ),
    ).rejects.toThrow(/asset\(\) returned/);
  });

  it("emits degraded warning when convertToAssets diverges from totalAssets by >1%", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: "0x000000000000000000000000000000000000000000000000000000000000006e" });
      }
      return null;
    });

    const { fetchCentrifugeVaultReserves } = await import("../centrifuge-vault");

    const result = await fetchCentrifugeVaultReserves(
      makeCoin(),
      makeConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "centrifuge-vault-nav-divergence",
        severity: "warning",
      }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.1, 2);
    expect(result.metadata?.redemption?.routeStatus).toBe("degraded");
  });

  it("falls back to ERC-20 totalSupply liveness when totalAssets is unavailable", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ error: { code: 3, message: "execution reverted" } });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000003aa7e4dff618e" });
      }
      return null;
    });

    const { fetchCentrifugeVaultReserves } = await import("../centrifuge-vault");

    const result = await fetchCentrifugeVaultReserves(
      makeCoin(),
      makeConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      {
        name: "U.S. Treasury bills via Janus Henderson Anemoy fund",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "centrifuge-vault-total-assets-unavailable",
        effect: "info",
      }),
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      contractAddress: JTRSY_VAULT,
      totalSupplyRaw: "1031884381315470",
      details: {
        proofKind: "centrifuge-vault-total-supply-liveness",
        totalAssetsUnavailable: true,
      },
    });
  });

  it("throws when asset() cannot be read", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({ result: "0x" });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      }
      return null;
    });

    const { fetchCentrifugeVaultReserves } = await import("../centrifuge-vault");

    await expect(
      fetchCentrifugeVaultReserves(
        makeCoin(),
        makeConfig(),
        new AbortController().signal,
        { chainRpcs: testChainRpcs },
      ),
    ).rejects.toThrow(/asset\(\) could not be read/);
  });
});
