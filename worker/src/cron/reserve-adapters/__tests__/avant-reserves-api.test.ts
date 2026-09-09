import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return { ...actual, fetchJsonWithRetry: vi.fn() };
});

import { adaptAvantReserves, fetchAvantReservesApiReserves, type AvantPayload } from "../avant-reserves-api";
import { fetchJsonWithRetry } from "../helpers";

const PAYLOAD = {"transparency": {"breakdown": {"updatedAtIso": "2026-09-01T23:59:59+00:00", "rows": [{"label": "Stablecoins", "valueUsd": 132734424.0812597}, {"label": "Other", "valueUsd": 19921859.53068356}, {"label": "ETH & Derivatives", "valueUsd": 4780.329286416491}, {"label": "AVAX & Derivatives", "valueUsd": 2676.974373216567}, {"label": "BTC & Derivatives", "valueUsd": 3.89663227662098}, {"label": "Perpetuals", "valueUsd": -19914992.49378}], "detailedData": [{"category": "Stablecoins", "totalValue": 132734424.08126, "grossValue": 1876838424.966687, "entries": [{"name": "usde", "label": "USDe", "value": 771038814.285026, "chains": [{"name": "Plasma", "value": 289128614.0565288}, {"name": "Ethereum", "value": 217423818.7771775}, {"name": "Base", "value": 123651033.6227255}, {"name": "Solana", "value": 90148082.37786332}, {"name": "Robinhood", "value": 50678632.11747582}, {"name": "Ink", "value": 8592.382007375365}, {"name": "Berachain", "value": 40.9512477389238}], "isDebt": false}, {"name": "syrupusdt", "label": "syrupUSDT", "value": 101293040.4781583, "chains": [{"name": "Ethereum", "value": 101293040.4781583}], "isDebt": false}, {"name": "syrupusdc", "label": "syrupUSDC", "value": 55367297.08160035, "chains": [{"name": "Ethereum", "value": 55367297.08160035}], "isDebt": false}, {"name": "amonusde", "label": "aMonUSDe", "value": 37541594.71079822, "chains": [{"name": "Monad", "value": 37541594.71079822}], "isDebt": false}, {"name": "usdc", "label": "USDC", "value": 33413517.40175128, "chains": [{"name": "Unknown", "value": 18269272.43903807}, {"name": "Solana", "value": 14026464.32689989}, {"name": "Avalanche", "value": 1116658.455961684}, {"name": "Arbitrum", "value": 998.749652355971}, {"name": "Bsc", "value": 109.751784540514}, {"name": "Ink", "value": 13.678414743733}], "isDebt": false}, {"name": "causd", "label": "cAUSD", "value": 6105690.669635527, "chains": [{"name": "Monad", "value": 6105690.669635527}], "isDebt": false}, {"name": "hyausd", "label": "hyAUSD", "value": 23264.31982058796, "chains": [{"name": "Monad", "value": 23264.31982058796}], "isDebt": false}, {"name": "usdt", "label": "USDT", "value": 1808.54499443746, "chains": [{"name": "Ethereum", "value": 1808.54499443746}], "isDebt": false}, {"name": "usdtb", "label": "USDtb", "value": 996.499008245512, "chains": [{"name": "Ethereum", "value": 996.499008245512}], "isDebt": false}, {"name": "usdat pt 8/27/26", "label": "USDat PT 8/27/26", "value": 101.87029792584, "chains": [{"name": "Ethereum", "value": 101.87029792584}], "isDebt": false}, {"name": "usdat", "label": "USDat", "value": 99.782464270992, "chains": [{"name": "Ethereum", "value": 50.027470208208}, {"name": "Bsc", "value": 49.754994062784}], "isDebt": false}, {"name": "usdt0", "label": "USDT0", "value": 94.72474494048001, "chains": [{"name": "Plasma", "value": 68.996870466675}, {"name": "Mantle", "value": 25.727874473805}], "isDebt": false}, {"name": "dai", "label": "DAI", "value": 35.42740113498284, "chains": [{"name": "Ethereum", "value": 35.42740113498284}], "isDebt": false}, {"name": "susde", "label": "sUSDe", "value": 22.3880209959499, "chains": [{"name": "Mantle", "value": 22.3880209959499}], "isDebt": false}, {"name": "usds", "label": "USDS", "value": 17.60311031935347, "chains": [{"name": "Ethereum", "value": 17.60311031935347}], "isDebt": false}, {"name": "wsrusd", "label": "wsrUSD", "value": 12.7370232, "chains": [{"name": "Sei", "value": 12.7370232}], "isDebt": false}, {"name": "savusd", "label": "savUSD", "value": 9.219951828091752, "chains": [{"name": "Ethereum", "value": 9.219951828091752}], "isDebt": false}, {"name": "usdf", "label": "USDf", "value": 3.956178920843181, "chains": [{"name": "Ethereum", "value": 3.956178920843181}], "isDebt": false}, {"name": "eusde", "label": "eUSDe", "value": 1.804899931231399, "chains": [{"name": "Ethereum", "value": 1.804899931231399}], "isDebt": true}, {"name": "re_pend_pt_susde_25sep2025_eth", "label": "RE_PEND_PT_SUSDE_25SEP2025_ETH", "value": 1.0190871, "chains": [{"name": "Ethereum", "value": 1.0190871}], "isDebt": false}, {"name": "usde", "label": "USDe", "value": -192.3826536391204, "chains": [{"name": "Unknown", "value": -192.3826536391204}], "isDebt": true}, {"name": "monusdc", "label": "MonUSDC", "value": -13705763.21795332, "chains": [{"name": "Monad", "value": -13705763.21795332}], "isDebt": true}, {"name": "monusdt0", "label": "MonUSDT0", "value": -20026715.67780122, "chains": [{"name": "Monad", "value": -20026715.67780122}], "isDebt": true}, {"name": "usdg", "label": "USDG", "value": -68446264.35064742, "chains": [{"name": "Robinhood", "value": -45321596.28219085}, {"name": "Solana", "value": -23124668.06845657}], "isDebt": true}, {"name": "pyusd", "label": "PYUSD", "value": -118634303.3680392, "chains": [{"name": "Solana", "value": -70441668.7023224}, {"name": "Ethereum", "value": -48192634.66571676}], "isDebt": true}, {"name": "usdt", "label": "USDT", "value": -160455843.4652604, "chains": [{"name": "Ethereum", "value": -160447895.3062679}, {"name": "Ink", "value": -7948.15899259638}], "isDebt": true}, {"name": "usdc", "label": "USDC", "value": -227782291.5400122, "chains": [{"name": "Ethereum", "value": -119470950.7899597}, {"name": "Base", "value": -108311320.3496478}, {"name": "Mantle", "value": -20.400404748207}], "isDebt": true}, {"name": "usdt0", "label": "USDT0", "value": -263000626.4403462, "chains": [{"name": "Plasma", "value": -263000626.4403462}], "isDebt": true}]}, {"category": "Other", "totalValue": 19921859.53068355, "grossValue": 19921859.53068355, "entries": [{"name": "hype", "label": "HYPE", "value": 18964014.97935343, "chains": [{"name": "Unknown", "value": 18964013.41413828}, {"name": "Hyperevm", "value": 1.56521515711475}], "isDebt": false}, {"name": "sena", "label": "sENA", "value": 638021.9964172553, "chains": [{"name": "Ethereum", "value": 638021.9964172553}], "isDebt": false}, {"name": "ena", "label": "ENA", "value": 311741.6158627449, "chains": [{"name": "Ethereum", "value": 311741.6158627449}], "isDebt": false}, {"name": "zest", "label": "ZEST", "value": 3417.118803553455, "chains": [{"name": "Stacks", "value": 3417.118803553455}], "isDebt": false}, {"name": "silo", "label": "SILO", "value": 1728.599457161936, "chains": [{"name": "Sonic", "value": 1728.599457161936}], "isDebt": false}, {"name": "mega", "label": "MEGA", "value": 1220.800223809153, "chains": [{"name": "Megaeth", "value": 1220.800223809153}], "isDebt": false}, {"name": "plume", "label": "PLUME", "value": 842.9426824545116, "chains": [{"name": "Plume", "value": 842.9426824545116}], "isDebt": false}, {"name": "reul", "label": "rEUL", "value": 226.8791252315341, "chains": [{"name": "Ethereum", "value": 226.8791252315341}], "isDebt": false}, {"name": "morpho", "label": "MORPHO", "value": 201.2593667378121, "chains": [{"name": "Ethereum", "value": 201.2593667378121}], "isDebt": false}, {"name": "mnt", "label": "MNT", "value": 168.1501618455256, "chains": [{"name": "Mantle", "value": 168.1501618455256}], "isDebt": false}, {"name": "mon", "label": "MON", "value": 78.27466209642802, "chains": [{"name": "Monad", "value": 78.27466209642802}], "isDebt": false}, {"name": "xpl", "label": "XPL", "value": 40.04900732909724, "chains": [{"name": "Plasma", "value": 40.04900732909724}], "isDebt": false}, {"name": "wxpl", "label": "WXPL", "value": 28.68366774254682, "chains": [{"name": "Plasma", "value": 28.68366774254682}], "isDebt": false}, {"name": "bera", "label": "BERA", "value": 27.1979516948835, "chains": [{"name": "Berachain", "value": 27.1979516948835}], "isDebt": false}, {"name": "xsilo", "label": "xSILO", "value": 24.6266278312143, "chains": [{"name": "Ethereum", "value": 24.6266278312143}], "isDebt": false}, {"name": "opasf", "label": "opASF", "value": 23.73350633010161, "chains": [{"name": "Ethereum", "value": 23.73350633010161}], "isDebt": false}, {"name": "sol", "label": "SOL", "value": 17.37459977495, "chains": [{"name": "Solana", "value": 17.37459977495}], "isDebt": false}, {"name": "sei", "label": "SEI", "value": 8.3904105589693, "chains": [{"name": "Sei", "value": 8.3904105589693}], "isDebt": false}, {"name": "cvx", "label": "CVX", "value": 7.169574874007828, "chains": [{"name": "Ethereum", "value": 7.169574874007828}], "isDebt": false}, {"name": "bnb", "label": "BNB", "value": 5.848393340293134, "chains": [{"name": "Bsc", "value": 5.848393340293134}], "isDebt": false}, {"name": "stx", "label": "STX", "value": 5.072811939048, "chains": [{"name": "Stacks", "value": 5.072811939048}], "isDebt": false}, {"name": "s", "label": "S", "value": 4.774729663344589, "chains": [{"name": "Sonic", "value": 4.774729663344589}], "isDebt": false}, {"name": "nect", "label": "NECT", "value": 2.110817535094866, "chains": [{"name": "Berachain", "value": 2.110817535094866}], "isDebt": false}, {"name": "gho", "label": "GHO", "value": 1.882468619115645, "chains": [{"name": "Monad", "value": 1.882468619115645}], "isDebt": false}]}, {"category": "ETH & Derivatives", "totalValue": 4780.329286416491, "grossValue": 4780.3292864164905, "entries": [{"name": "eth", "label": "ETH", "value": 4771.792752720765, "chains": [{"name": "Base", "value": 2185.988396595465}, {"name": "Ethereum", "value": 1402.866407823744}, {"name": "Arbitrum", "value": 791.9588728961673}, {"name": "Optimism", "value": 241.6489579005594}, {"name": "Ink", "value": 110.9533251537618}, {"name": "Megaeth", "value": 25.75957623614972}, {"name": "Robinhood", "value": 12.61721611491796}], "isDebt": false}, {"name": "weth", "label": "WETH", "value": 8.536533695725286, "chains": [{"name": "Ink", "value": 6.120757746442052}, {"name": "Ethereum", "value": 2.415775949283233}], "isDebt": false}]}, {"category": "AVAX & Derivatives", "totalValue": 2676.974373216567, "grossValue": 2676.9743732165675, "entries": [{"name": "avax", "label": "AVAX", "value": 2266.87054907762, "chains": [{"name": "Avalanche", "value": 2266.87054907762}], "isDebt": false}, {"name": "wavax", "label": "WAVAX", "value": 410.1038241389474, "chains": [{"name": "Avalanche", "value": 410.1038241389474}], "isDebt": false}]}, {"category": "BTC & Derivatives", "totalValue": 3.89663227662098, "grossValue": 3.89663227662098, "entries": [{"name": "xsolvbtc", "label": "xSolvBTC", "value": 3.89663227662098, "chains": [{"name": "Bsc", "value": 3.89663227662098}], "isDebt": false}]}, {"category": "Perpetuals", "totalValue": -19914992.49378, "grossValue": 19914992.49378, "entries": [{"name": "ena perp (hyperliquid)", "label": "ENA Perp (Hyperliquid)", "value": -949763.61228, "chains": [{"name": "Unknown", "value": -949763.61228}], "isDebt": true}, {"name": "hype perp (hyperliquid)", "label": "HYPE Perp (Hyperliquid)", "value": -18965228.8815, "chains": [{"name": "Unknown", "value": -18965228.8815}], "isDebt": true}]}]}, "location": {"updatedAtIso": "2026-09-01T23:59:59+00:00", "rows": [{"label": "Protocol Deployments", "valueUsd": 114294416.4188598}, {"label": "Pending Deployment", "valueUsd": 1136242.117045007}, {"label": "Bridges", "valueUsd": 17318101.26750012}]}, "leverage": {"updatedAtIso": "2026-09-01T23:59:59+00:00", "assetsUsd": 1024715743.450049, "liabilitiesUsd": 891966994.7413934, "coveragePercent": 114.8826973970201}, "nav": {"netNav": 132748763.3728162, "periodEnd": "2026-09-01T23:59:59+00:00"}}} as unknown as AvantPayload;

function makeCoin(): StablecoinMeta {
  return { id: "avusd-avant", name: "avUSD", symbol: "avUSD" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "avant-reserves-api",
    version: 1,
    semantics: "collateral-mix",
    inputs: { primary: { kind: "http-json", url: "https://app.avantprotocol.com/api/metrics/avusd" } },
    params: {},
  } as unknown as LiveReservesConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptAvantReserves", () => {
  it("publishes gross long slices with debt as separate totals, never netted", () => {
    const result = adaptAvantReserves(structuredClone(PAYLOAD));

    expect(result.slices).toHaveLength(2);
    const stable = result.slices.find((s) => s.sourceKey === "avant-reserves-api:stablecoin-long")!;
    const other = result.slices.find((s) => s.sourceKey === "avant-reserves-api:other-long")!;
    expect(stable.pct).toBeCloseTo(98.1, 1);
    expect(other.pct).toBeCloseTo(1.9, 1);
    expect(stable.risk).toBe("medium");
    expect(result.slices.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 6);

    expect(result.metadata).toMatchObject({
      totalAssetsUsd: expect.closeTo(1_024_715_743.450049, 4),
      totalLiabilitiesUsd: expect.closeTo(891_966_994.7413934, 4),
      collateralizationRatio: expect.closeTo(1_024_715_743.450049 / 891_966_994.7413934, 9),
      referenceNavUsd: expect.closeTo(132_748_763.3728162, 4),
      freshnessMode: "verified",
      sourceTimestamp: Math.floor(Date.parse("2026-09-01T23:59:59+00:00") / 1000),
    });
    expect(result.metadata!.details).toMatchObject({
      freshnessSource: "avant-reserve-snapshot",
      perpShortsUsd: expect.closeTo(949_763.61228 + 18_965_228.8815, 4),
      bridgesUsd: expect.closeTo(17_318_101.26750012, 4),
      unknownChainLongUsd: expect.closeTo(18_269_272.44 + 18_964_013.413176355, 6),
      navPeriodEnd: "2026-09-01T23:59:59+00:00",
    });
    // Debt stays out of the slices: stablecoin slice = long leg only.
    const stableLong = 1_004_786_422.7190735;
    expect(stable.pct).toBeCloseTo(stableLong / 1_024_715_743.450049 * 100, 1);
    expect(result.warnings!.map((w) => w.code).sort())
      .toEqual(["bridges-positions-reported", "gross-leverage-disclosed"]);
    expect(result.warnings!.every((w) => w.effect === "info")).toBe(true);
  });

  it("fails closed when the reserve snapshot timestamps disagree", () => {
    const payload = structuredClone(PAYLOAD);
    payload.transparency.leverage.updatedAtIso = "2026-09-09T00:00:00+00:00";
    expect(() => adaptAvantReserves(payload)).toThrow("timestamps disagree");
  });

  it("fails closed when a category total disagrees with its entries", () => {
    const payload = structuredClone(PAYLOAD);
    payload.transparency.breakdown.detailedData[0]!.entries[0]!.value += 1_000_000;
    expect(() => adaptAvantReserves(payload)).toThrow("disagrees with category totalValue");
  });

  it("fails closed when a long entry is signed as debt", () => {
    const payload = structuredClone(PAYLOAD);
    payload.transparency.breakdown.detailedData[0]!.entries[0]!.isDebt = true;
    expect(() => adaptAvantReserves(payload)).toThrow("gross long sum");
  });

  it("fails closed when the breakdown rows disagree with net NAV", () => {
    const payload = structuredClone(PAYLOAD);
    payload.transparency.nav.netNav += 500_000;
    expect(() => adaptAvantReserves(payload)).toThrow("disagrees with net NAV");
  });
});

describe("fetchAvantReservesApiReserves", () => {
  it("fetches and adapts the metrics payload", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(structuredClone(PAYLOAD));
    const result = await fetchAvantReservesApiReserves(makeCoin(), makeConfig(), new AbortController().signal);
    expect(result.slices).toHaveLength(2);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(1);
  });

  it("propagates upstream failures", async () => {
    vi.mocked(fetchJsonWithRetry).mockRejectedValue(new Error("HTTP 503"));
    await expect(fetchAvantReservesApiReserves(makeCoin(), makeConfig(), new AbortController().signal))
      .rejects.toThrow("HTTP 503");
  });
});
