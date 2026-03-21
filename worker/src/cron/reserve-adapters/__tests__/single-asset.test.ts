import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    fetchErc20TotalSupply: vi.fn(),
  };
});

import { fetchSingleAssetReserves } from "../single-asset";
import { fetchJsonWithRetry, fetchErc20TotalSupply } from "../helpers";

const signal = AbortSignal.timeout(5000);

function makeCoin(contracts?: Array<{ chain: string; address: string }>): StablecoinMeta {
  return { id: "test-coin", name: "Test", ticker: "TST", contracts } as unknown as StablecoinMeta;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchSingleAssetReserves", () => {
  it("returns 100% slice in http-json mode when probe returns non-zero", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "1000000" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    };

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
  });

  it("preserves optional coinId and depType in the slice", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ value: "42" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "USDC backing",
        risk: "very-low",
        coinId: "usdc-circle",
        depType: "wrapper",
        probe: { kind: "json-path", path: ["value"] },
      },
    };

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.slices).toEqual([
      { name: "USDC backing", pct: 100, risk: "very-low", coinId: "usdc-circle", depType: "wrapper" },
    ]);
  });

  it("throws on zero probe value in http-json mode", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "0" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("zero/empty");
  });

  it("throws on '0.0' probe value in http-json mode", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "0.0" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("zero/empty");
  });

  it("throws when http-json mode has no probe configured", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ value: "100" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: { label: "Test", risk: "low" },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("params.probe.kind = json-path");
  });

  it("throws on invalid risk value", async () => {
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: { label: "Test", risk: "invalid-risk" },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("invalid risk");
  });

  it("throws when label is missing", async () => {
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: { risk: "low" },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("params.label and params.risk");
  });

  it("returns 100% slice in onchain mode when totalSupply > 0", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(1000000n);
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { label: "ETH collateral", risk: "low" },
    };

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      config,
      signal,
    );
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
  });

  it("throws when chain does not match any contract", async () => {
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { label: "Collateral", risk: "medium" },
    };

    await expect(fetchSingleAssetReserves(
      makeCoin([{ chain: "arbitrum", address: "0xABCD" }]),
      config,
      signal,
    )).rejects.toThrow("could not find a ethereum contract");
  });

  it("throws when onchain mode has no contracts", async () => {
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { label: "ETH collateral", risk: "low" },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("could not find a ethereum contract");
  });

  it("throws when onchain totalSupply is null", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(null);
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { label: "ETH collateral", risk: "low" },
    };

    await expect(
      fetchSingleAssetReserves(
        makeCoin([{ chain: "ethereum", address: "0x1234" }]),
        config,
        signal,
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });

  it("throws when onchain totalSupply is zero", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(0n);
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { label: "ETH collateral", risk: "low" },
    };

    await expect(
      fetchSingleAssetReserves(
        makeCoin([{ chain: "ethereum", address: "0x1234" }]),
        config,
        signal,
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });
});
