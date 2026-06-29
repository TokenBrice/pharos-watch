import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "usdc-circle",
      symbol: "USDC",
      contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
      tradedContracts: [],
    },
    {
      id: "eurc-circle",
      symbol: "EURC",
      contracts: [{ chain: "base", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 }],
      tradedContracts: [],
    },
  ];

  return {
    ACTIVE_STABLECOINS: stablecoins,
    TRACKED_META_BY_ID: new Map(stablecoins.map((coin) => [coin.id, coin])),
  };
});

import { fetchVaultsFyiSources } from "../yield-sync/vaults-fyi";
import type { VaultsFyiRuntimeConfig } from "../../lib/env";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function enabledConfig(overrides: Partial<Extract<VaultsFyiRuntimeConfig, { enabled: true }>> = {}): VaultsFyiRuntimeConfig {
  return {
    enabled: true,
    apiKey: "test-placeholder-key",
    rankableVaults: [],
    maxCreditsPerRun: null,
    maxCreditsPerMonth: null,
    maxPagesPerRun: null,
    ...overrides,
  };
}

function detailedVault(overrides: Record<string, unknown> = {}) {
  return {
    vaultId: "mainnet-0x1111111111111111111111111111111111111111",
    address: "0x1111111111111111111111111111111111111111",
    name: "Prime USDC Vault",
    network: { name: "mainnet", chainId: 1, networkCaip: "eip155:1" },
    asset: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "SPOOF",
    },
    protocol: { name: "Example", slug: "example" },
    score: { vaultScore: 90 },
    apy: {
      "7day": { base: 0.031, reward: 0.011, total: 0.042 },
    },
    tvl: { usd: "1250000", native: "1250000" },
    lastUpdateTimestamp: "2026-06-12T12:30:00.000Z",
    ...overrides,
  };
}

describe("fetchVaultsFyiSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("skips without fetching when disabled", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchVaultsFyiSources({
      config: {
        enabled: false,
        apiKey: null,
        rankableVaults: [],
        maxCreditsPerRun: null,
        maxCreditsPerMonth: null,
        maxPagesPerRun: null,
      },
    })).resolves.toMatchObject({
      candidates: [],
      telemetry: { status: "skipped", skipReason: "disabled", requestCount: 0 },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs a cheap audit-only inventory probe when enabled without rankable vaults", async () => {
    const fetchSpy = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/v2/detailed-vaults?");
      expect(url).toContain("page=0");
      expect(url).toContain("perPage=8");
      expect(url).not.toContain("test-placeholder-key");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-placeholder-key");
      return response({ data: [detailedVault(), detailedVault({ address: "0x2222222222222222222222222222222222222222" })] });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig(),
      startSec: 1_781_267_400,
    });

    expect(result.candidates).toEqual([]);
    expect(result.telemetry).toMatchObject({
      status: "ok",
      skipReason: null,
      requestCount: 1,
      pageCount: 1,
      creditsEstimated: 7,
      rawVaultCount: 2,
      auditOnlyCount: 2,
      rankableCandidateCount: 0,
    });
  });

  it("emits exact address-matched allowlisted candidates from detailed-vault pagination and drops symbol-only spoofed assets", async () => {
    const fetchSpy = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/v2/detailed-vaults?");
      expect(url).toContain("allowedNetworks=mainnet");
      expect(url).not.toContain("test-placeholder-key");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-placeholder-key");

      return response({
        nextPage: null,
        data: [
          detailedVault(),
          detailedVault({
            vaultId: "vault-b",
            address: "0x2222222222222222222222222222222222222222",
            name: "Spoofed USDC Vault",
            asset: {
              address: "0x9999999999999999999999999999999999999999",
              symbol: "USDC",
            },
          }),
        ],
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({
        maxCreditsPerRun: 100,
        rankableVaults: [
          "mainnet/0x1111111111111111111111111111111111111111",
          "mainnet/vault-b",
        ],
      }),
      startSec: 1_781_267_400,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      chain: "ethereum",
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      yield: {
        currentApy: expect.closeTo(4.2, 6),
        apyBase: expect.closeTo(3.1, 6),
        apyReward: expect.closeTo(1.1, 6),
        sourcePool: "mainnet-0x1111111111111111111111111111111111111111",
        sourceTvlUsd: 1_250_000,
        dataSource: "protocol-api",
        sourceKey: "protocol-api:vaults-fyi:ethereum:0x1111111111111111111111111111111111111111",
        yieldSource: "Example: Prime USDC Vault",
        yieldType: "lending-opportunity",
        project: "example",
        sourceObservedAt: 1_781_267_400,
      },
    });
    expect(result.telemetry).toMatchObject({
      status: "ok",
      requestCount: 1,
      pageCount: 1,
      rawVaultCount: 2,
      rankableCandidateCount: 1,
      identityMissCount: 1,
      creditsEstimated: 7,
    });
  });

  it("stops before a detail fetch when the local per-run credit cap is too low", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({
        rankableVaults: ["mainnet:vault-a"],
        maxCreditsPerRun: 2,
      }),
      startSec: 1_781_267_400,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "skipped",
        skipReason: "credit-cap",
        requestCount: 0,
        creditsEstimated: 0,
      },
    });
  });

  it("does not spend credits when all rankable allowlist entries are malformed", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({ rankableVaults: ["not-a-vault-entry"] }),
      startSec: 1_781_267_400,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "skipped",
        skipReason: "invalid-payload",
        requestCount: 0,
        creditsEstimated: 0,
      },
    });
  });

  it("fails open as skipped on provider quota responses without emitting candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "quota" }, 429)));

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({ rankableVaults: ["mainnet:vault-a"] }),
      startSec: 1_781_267_400,
    });

    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "skipped",
        skipReason: "provider-quota",
        requestCount: 1,
        creditsEstimated: 0,
      },
    });
  });
});
