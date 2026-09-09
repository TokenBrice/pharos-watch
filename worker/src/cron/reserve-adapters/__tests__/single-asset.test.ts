import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    probeOnchainTotalSupply: vi.fn(),
  };
});

import { fetchSingleAssetReserves } from "../single-asset";
import {
  fetchJsonWithRetry,
  probeOnchainTotalSupply,
} from "../helpers";

let signal: AbortSignal;
const unexpectedRequests: string[] = [];
afterEach(() => expect(unexpectedRequests.splice(0)).toEqual([]));

function makeSingleAssetConfig(
  overrides: {
    primary?: LiveReservesConfig["inputs"]["primary"];
    params?: Record<string, unknown>;
  } = {},
): LiveReservesConfig {
  return {
    adapter: "single-asset",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: overrides.primary ?? { kind: "http-json", url: "https://example.com/api" },
    },
    params: overrides.params ?? {},
  };
}

function makeCoin(contracts?: Array<{ chain: string; address: string }>): StablecoinMeta {
  return { id: "test-coin", name: "Test", ticker: "TST", contracts } as unknown as StablecoinMeta;
}

beforeEach(() => {
  signal = new AbortController().signal;
  vi.clearAllMocks();
});

describe("fetchSingleAssetReserves", () => {
  it("returns 100% slice in http-json mode when probe returns non-zero", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "1000000" });
    const config = makeSingleAssetConfig({
      params: {
        label: "ETH collateral",
        risk: "low",
        reserveProbe: { kind: "json-path", path: ["total_supply"] },
      },
    });

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
    const config = makeSingleAssetConfig({
      params: {
        label: "USDC backing",
        risk: "very-low",
        coinId: "usdc-circle",
        depType: "wrapper",
        reserveProbe: { kind: "json-path", path: ["value"] },
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.slices).toEqual([
      { name: "USDC backing", pct: 100, risk: "very-low", coinId: "usdc-circle", depType: "wrapper" },
    ]);
  });

  it.each(["0", "0.0"])("throws on '%s' probe value in http-json mode", async (probeValue) => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: probeValue });
    const config = makeSingleAssetConfig({
      params: {
        label: "ETH collateral",
        risk: "low",
        reserveProbe: { kind: "json-path", path: ["total_supply"] },
      },
    });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("zero/empty");
  });

  it("throws when http-json mode has no probe configured", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ value: "100" });
    const config = makeSingleAssetConfig({ params: { label: "Test", risk: "low" } });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("params.reserveProbe or params.supplyProbe");
  });

  it.each([
    { name: "invalid risk value", params: { label: "Test", risk: "invalid-risk" } },
    { name: "label is missing", params: { risk: "low" } },
  ])("throws when $name", async ({ params }) => {
    const config = makeSingleAssetConfig({ params });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("single-asset adapter params invalid");
  });

  it("returns 100% slice in onchain mode when probe succeeds", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);
    const config = makeSingleAssetConfig({
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      params: { label: "ETH collateral", risk: "low" },
    });

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

  it("computes reserve and supply metadata when richer json probes are configured", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      reserve_total: "105000000",
      supply_total: "100000000",
      asOf: "2026-03-20T12:00:00Z",
    });
    const config = makeSingleAssetConfig({
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        reserveProbe: { kind: "json-path", path: ["reserve_total"] },
        supplyProbe: { kind: "json-path", path: ["supply_total"] },
        timestampProbe: { kind: "json-path", path: ["asOf"] },
        reserveSourceLabel: "Issuer reserve dashboard",
      },
    });

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

  it("emits a degraded warning when meaningful reserve/supply probes are undercollateralized", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      reserve_total: "99000000",
      supply_total: "100000000",
      asOf: "2026-03-20T12:00:00Z",
    });
    const config = makeSingleAssetConfig({
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        reserveProbe: { kind: "json-path", path: ["reserve_total"] },
        supplyProbe: { kind: "json-path", path: ["supply_total"] },
        timestampProbe: { kind: "json-path", path: ["asOf"] },
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.metadata?.collateralizationRatio).toBe(0.99);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
  });

  it("marks timestamp-backed liveness probes as freshness-verified even without reserve totals", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      data: {
        price: "1.120735576038699094",
        timestamp: "1774874195",
      },
    });
    const config = makeSingleAssetConfig({
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        reserveProbe: { kind: "json-path", path: ["data", "price"] },
        timestampProbe: { kind: "json-path", path: ["data", "timestamp"] },
      },
    });

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

  it("propagates a failed on-chain supply probe", async () => {
    const error = new Error("RPC unavailable");
    vi.mocked(probeOnchainTotalSupply).mockRejectedValue(error);
    const config = makeSingleAssetConfig({
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      params: { label: "Collateral", risk: "medium" },
    });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal)).rejects.toBe(error);
  });
});
