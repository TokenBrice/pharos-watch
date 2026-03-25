import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    fetchOnchainRateBps: vi.fn(),
    probeOnchainTotalSupply: vi.fn(),
  };
});

import { fetchSingleAssetReserves } from "../single-asset";
import { fetchJsonWithRetry, fetchOnchainRateBps, probeOnchainTotalSupply } from "../helpers";

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
      .rejects.toThrow("single-asset adapter params invalid");
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
      .rejects.toThrow("single-asset adapter params invalid");
  });

  it("returns 100% slice in onchain mode when probe succeeds", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);
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

  it("includes live redemption fee metadata when a probe is configured", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);
    vi.mocked(fetchOnchainRateBps).mockResolvedValue(50);
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        label: "ETH collateral",
        risk: "low",
        redemptionRateProbe: {
          contract: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
          selector: "0xc52861f2",
        },
      },
    };

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      config,
      signal,
    );

    expect(result.metadata).toEqual({ freshnessMode: "not-applicable", redemptionFeeBps: 50 });
  });

  it("throws when on-chain probe fails", async () => {
    vi.mocked(probeOnchainTotalSupply).mockRejectedValue(
      new Error("single-asset could not find a ethereum contract for test-coin"),
    );
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

  it("throws when on-chain probe returns zero supply", async () => {
    vi.mocked(probeOnchainTotalSupply).mockRejectedValue(
      new Error("single-asset totalSupply probe failed for test-coin"),
    );
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
