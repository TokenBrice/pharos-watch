import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchJsonWithRetry: vi.fn(),
  };
});

vi.mock("../request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../request")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    fetchJsonPostWithRetry: vi.fn(),
  };
});

import { adaptHliquityHederaState, fetchHliquityHederaReserves, type HliquityHederaState } from "../hliquity-hedera";
import { fetchDefiLlamaPrices, fetchJsonWithRetry } from "../helpers";
import { fetchJsonPostWithRetry, fetchJsonWithRetry as fetchJsonWithRetryFromRequest } from "../request";

const coin = { id: "hchf-hedera-swiss-franc" } as StablecoinMeta;
const config: LiveReservesConfig = {
  adapter: "hliquity-hedera",
  version: 1,
  semantics: "collateral-mix",
  inputs: {
    primary: { kind: "http-json", url: "https://mainnet-public.mirrornode.hedera.com/api/v1" },
  },
  params: {},
};

// Captured 2026-09-09 from the public mirror node at block 99,808,682
// (timestamp 1788980926.470211104): the live HLiquity chain-295 system state.
const PINNED_BLOCK = { blocks: [{ number: 99_808_682, timestamp: { from: "1788980926.470211104" } }] };
const TROVE_COLLATERAL = 261_148_967_796_086n;
const SP_COLLATERAL = 3_131_532_042_973n;
const DEBT = 6_401_905_358_754n;
const SUPPLY = 6_401_905_358_754n;
const MCR = 110_000_000n; // 1.10 in 8-decimal ratio units
const PROTOCOL_PRICE = 6_314_601n; // HBAR/USD oracle word, 8 decimals
const TCR = 257_565_087n; // 2.5757 in 8-decimal ratio units
const HBAR_PRICE_USD = 0.0781731404466302;
const CHF_USD_RATE = 1.239;

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function buildState(overrides: Partial<HliquityHederaState> = {}): HliquityHederaState {
  return {
    block: { number: 99_808_682, timestampSec: 1_788_980_926, fromIso: "1788980926.470211104" },
    troveCollateralRaw: TROVE_COLLATERAL,
    stabilityPoolCollateralRaw: SP_COLLATERAL,
    debtRaw: DEBT,
    supplyRaw: SUPPLY,
    mcrRaw: MCR,
    tcrRaw: TCR,
    protocolPriceRaw: PROTOCOL_PRICE,
    hbarPriceUsd: HBAR_PRICE_USD,
    chfUsdRate: CHF_USD_RATE,
    fxRateDate: "2026-09-09",
    nowSec: 1_788_980_926,
    ...overrides,
  };
}

describe("adaptHliquityHederaState", () => {
  it("publishes the pinned same-block HBAR census with a market-valued collateralization ratio", () => {
    const result = adaptHliquityHederaState(buildState());

    const totalHbar = Number(TROVE_COLLATERAL + SP_COLLATERAL) / 1e8;
    const debtHchf = Number(DEBT) / 1e8;
    expect(result.slices).toEqual([expect.objectContaining({
      sourceKey: "hliquity-hedera:hbar",
      pct: 100,
      risk: "high",
      assetClass: "cryptoasset",
    })]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(totalHbar * HBAR_PRICE_USD, 4);
    expect(result.metadata?.totalLiabilitiesUsd).toBeCloseTo(debtHchf * CHF_USD_RATE, 4);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(
      (totalHbar * HBAR_PRICE_USD) / (debtHchf * CHF_USD_RATE),
      4,
    );
    expect(result.metadata?.supplyTokens).toBeCloseTo(debtHchf, 8);
    expect(result.metadata?.observedBlock).toEqual({ chain: "hedera", number: 99_808_682, timestamp: 1_788_980_926 });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open", capacityUsd: result.metadata?.totalLiabilitiesUsd });
    expect(result.warnings).toBeUndefined();
  });

  it("omits valuation and degrades when the HBAR price is unavailable", () => {
    const result = adaptHliquityHederaState(buildState({ hbarPriceUsd: undefined }));

    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hbar-price-unavailable", effect: "degraded" }),
    ]));
  });

  it("degrades but still publishes an undercollateralized market ratio below MCR", () => {
    const result = adaptHliquityHederaState(buildState({ hbarPriceUsd: 0.01 }));

    expect(result.metadata?.collateralizationRatio).toBeLessThan(1.1);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
    ]));
  });

  it("reports the redemption route paused when the protocol TCR clears below MCR", () => {
    const result = adaptHliquityHederaState(buildState({ tcrRaw: 100_000_000n }));

    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused" });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "redemption-route-status-degraded", effect: "degraded" }),
    ]));
  });

  it("fails closed on a zero collateral or debt census", () => {
    expect(() => adaptHliquityHederaState(buildState({ troveCollateralRaw: 0n, stabilityPoolCollateralRaw: 0n })))
      .toThrow(/collateral/);
    expect(() => adaptHliquityHederaState(buildState({ debtRaw: 0n }))).toThrow(/debt/);
  });
});

describe("fetchHliquityHederaReserves", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.mocked(fetchJsonWithRetryFromRequest).mockResolvedValue(PINNED_BLOCK);
    vi.mocked(fetchJsonPostWithRetry).mockImplementation(async (_url, body) => {
      const { to, data } = body as { to: string; data: string };
      if (to === "0x00000000000000000000000000000000005c9f66" && data.startsWith("0x887105d3")) return { result: word(TROVE_COLLATERAL) };
      if (to === "0x00000000000000000000000000000000005c9f66" && data.startsWith("0x795d26c3")) return { result: word(DEBT) };
      if (to === "0x00000000000000000000000000000000005c9f5c" && data.startsWith("0x14f6c3be")) return { result: word(SP_COLLATERAL) };
      if (to === "0x00000000000000000000000000000000005c9f66" && data.startsWith("0x794e5724")) return { result: word(MCR) };
      if (to === "0x00000000000000000000000000000000005c9f42" && data.startsWith("0x0fdb11cf")) return { result: word(PROTOCOL_PRICE) };
      if (to === "0x00000000000000000000000000000000005c9f6b" && data.startsWith("0x18160ddd")) return { result: word(SUPPLY) };
      if (to === "0x00000000000000000000000000000000005c9f66" && data.startsWith("0xb82f263d")) return { result: word(TCR) };
      throw new Error(`unexpected mirror call to=${to} data=${data.slice(0, 10)}`);
    });
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ base: "CHF", date: "2026-09-09", rates: { USD: CHF_USD_RATE } });
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["HBAR", HBAR_PRICE_USD]]));
  });

  it("runs the pinned same-block census end to end", async () => {
    const result = await fetchHliquityHederaReserves(coin, config, signal);

    expect(result.metadata?.observedBlock).toEqual({ chain: "hedera", number: 99_808_682, timestamp: 1_788_980_926 });
    expect(result.metadata?.details).toMatchObject({
      blockNumber: 99_808_682,
      troveCollateralRaw: TROVE_COLLATERAL.toString(),
      stabilityPoolCollateralRaw: SP_COLLATERAL.toString(),
      debtRaw: DEBT.toString(),
      supplyRaw: SUPPLY.toString(),
      chfUsdRate: CHF_USD_RATE,
      fxRateDate: "2026-09-09",
    });
    // Every mirror call is pinned to the same hex block number.
    const blockParams = vi.mocked(fetchJsonPostWithRetry).mock.calls.map(([, body]) => (body as { block: string }).block);
    expect(blockParams.length).toBeGreaterThanOrEqual(6);
    expect(new Set(blockParams)).toEqual(new Set(["0x5f2f5aa"]));
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
  });

  it("fails closed when the CHF/USD reference rate is missing", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ base: "CHF", date: "2026-09-09", rates: {} });

    await expect(fetchHliquityHederaReserves(coin, config, signal)).rejects.toThrow(/CHF\/USD/);
  });

  it("fails closed when the CHF/USD reference rate is stale", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ base: "CHF", date: "2026-08-01", rates: { USD: CHF_USD_RATE } });

    await expect(fetchHliquityHederaReserves(coin, config, signal)).rejects.toThrow(/freshness window/);
  });

  it("degrades when DefiLlama returns no HBAR quote", async () => {
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map());

    const result = await fetchHliquityHederaReserves(coin, config, signal);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hbar-price-unavailable", effect: "degraded" }),
    ]));
  });
});
