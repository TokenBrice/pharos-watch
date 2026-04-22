import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    probeOptionalRedemptionRateBps: vi.fn(),
    probeOnchainTotalSupply: vi.fn(),
  };
});

import { fetchSingleAssetReserves } from "../single-asset";
import { fetchJsonWithRetry, probeOnchainTotalSupply, probeOptionalRedemptionRateBps } from "../helpers";

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
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "ETH collateral",
      },
    });
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
      .rejects.toThrow("params.probe/reserveProbe or params.supplyProbe");
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
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "erc20-total-supply-liveness",
      },
    });
  });

  it("includes live redemption fee metadata when a probe is configured", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
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

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      redemptionFeeBps: 50,
      details: {
        proofKind: "erc20-total-supply-liveness",
      },
    });
  });

  it("computes reserve and supply metadata when richer json probes are configured", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      reserve_total: "105000000",
      supply_total: "100000000",
      asOf: "2026-03-20T12:00:00Z",
    });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        reserveProbe: { kind: "json-path", path: ["reserve_total"] },
        supplyProbe: { kind: "json-path", path: ["supply_total"] },
        timestampProbe: { kind: "json-path", path: ["asOf"] },
        reserveSourceLabel: "Issuer reserve dashboard",
      },
    };

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 105000000,
      supplyUsd: 100000000,
      collateralizationRatio: 1.05,
      sourceTimestamp: Date.parse("2026-03-20T12:00:00Z") / 1000,
      freshnessMode: "verified",
      details: {
        proofKind: "reserve-and-supply-probe",
        reserveSourceLabel: "Issuer reserve dashboard",
      },
    });
  });

  it("marks timestamp-backed liveness probes as freshness-verified even without reserve totals", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      data: {
        price: "1.120735576038699094",
        timestamp: "1774874195",
      },
    });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        probe: { kind: "json-path", path: ["data", "price"] },
        timestampProbe: { kind: "json-path", path: ["data", "timestamp"] },
      },
    };

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_774_874_195,
      freshnessMode: "verified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "Treasury reserve",
      },
    });
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
