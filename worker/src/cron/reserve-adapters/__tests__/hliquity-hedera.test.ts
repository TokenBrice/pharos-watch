import { describe, expect, it } from "vitest";
import { adaptHliquityHederaState, type HliquityHederaState } from "../hliquity-hedera";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com/api/v1";
const BLOCK_URL = `${MIRROR_BASE}/blocks?limit=1&order=desc`;
const CALL_URL = `${MIRROR_BASE}/contracts/call`;
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?base=CHF&symbols=USD";
const DEFILLAMA_URL = "https://coins.llama.fi/prices/current/coingecko:hedera-hashgraph";

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

function hederaNetwork(options: {
  fxDate?: string;
  fxRate?: number | null;
  hbarPrice?: number | null;
} = {}): AdapterNetworkSpec {
  const fx = options.fxRate === undefined
    ? { base: "CHF", date: options.fxDate ?? "2026-09-09", rates: { USD: CHF_USD_RATE } }
    : options.fxRate === null
      ? { base: "CHF", date: options.fxDate ?? "2026-09-09", rates: {} }
      : { base: "CHF", date: options.fxDate ?? "2026-09-09", rates: { USD: options.fxRate } };
  const hbarPrice = options.hbarPrice === undefined ? HBAR_PRICE_USD : options.hbarPrice;
  return {
    json: {
      [BLOCK_URL]: PINNED_BLOCK,
      [CALL_URL]: async (request: Request) => {
        const body = await request.clone().json() as { to: string; data: string };
        if (body.to === "0x00000000000000000000000000000000005c9f66" && body.data.startsWith("0x887105d3")) return { result: word(TROVE_COLLATERAL) };
        if (body.to === "0x00000000000000000000000000000000005c9f66" && body.data.startsWith("0x795d26c3")) return { result: word(DEBT) };
        if (body.to === "0x00000000000000000000000000000000005c9f5c" && body.data.startsWith("0x14f6c3be")) return { result: word(SP_COLLATERAL) };
        if (body.to === "0x00000000000000000000000000000000005c9f66" && body.data.startsWith("0x794e5724")) return { result: word(MCR) };
        if (body.to === "0x00000000000000000000000000000000005c9f42" && body.data.startsWith("0x0fdb11cf")) return { result: word(PROTOCOL_PRICE) };
        if (body.to === "0x00000000000000000000000000000000005c9f6b" && body.data.startsWith("0x18160ddd")) return { result: word(SUPPLY) };
        if (body.to === "0x00000000000000000000000000000000005c9f66" && body.data.startsWith("0xb82f263d")) return { result: word(TCR) };
        throw new Error(`unexpected mirror call to=${body.to} data=${body.data.slice(0, 10)}`);
      },
      [FRANKFURTER_URL]: fx,
      [DEFILLAMA_URL]: {
        coins: hbarPrice == null ? {} : {
          "coingecko:hedera-hashgraph": {
            price: hbarPrice,
            timestamp: 1_788_980_926,
            confidence: 1,
          },
        },
      },
    },
  };
}

const NOW_SEC = 1_788_980_926;


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
  it("runs the pinned same-block census end to end", async () => {
    const { result, network } = await runAdapter("hliquity-hedera", "hchf-hedera-swiss-franc", {
      network: hederaNetwork(),
      nowSec: NOW_SEC,
    });

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
    expect(network.requests.filter(({ url }) => url === CALL_URL)).toHaveLength(7);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
  });

  it("fails closed when the CHF/USD reference rate is missing", async () => {
    await expect(runAdapter("hliquity-hedera", "hchf-hedera-swiss-franc", {
      network: hederaNetwork({ fxRate: null }),
      nowSec: NOW_SEC,
    })).rejects.toThrow(/CHF\/USD/);
  });

  it("fails closed when the CHF/USD reference rate is stale", async () => {
    await expect(runAdapter("hliquity-hedera", "hchf-hedera-swiss-franc", {
      network: hederaNetwork({ fxDate: "2026-08-01" }),
      nowSec: NOW_SEC,
    })).rejects.toThrow(/freshness window/);
  });

  it("degrades when DefiLlama returns no HBAR quote", async () => {
    const { result } = await runAdapter("hliquity-hedera", "hchf-hedera-swiss-franc", {
      network: hederaNetwork({ hbarPrice: null }),
      nowSec: NOW_SEC,
    });
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hbar-price-unavailable", effect: "degraded" }),
    ]));
  });
});
