import { describe, expect, it, beforeEach, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchUsdgoTransparencyReserves } from "../usdgo-transparency";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";
import { fetchEvmRpcBatch } from "../../../lib/evm-rpc";
import { fetchJsonWithRetry } from "../helpers";
import { fetchIndependentAssuranceReserves } from "../independent-assurance";

const REPORT_BLOCK = 89_166_720;
const REPORT_BLOCK_HASH = "0xf39651e0ea42f8f78d0d375fa39ddd531896083e3f5c1daef7e7efa987ee7939";
const REPORT_TIMESTAMP = 1_782_863_999;
const BUIDL_RAW = 170_977_843_010_000n;
const CODE_HASH = "0xee8a105971995661291a9f284262a87abf2381b3cdc93b2c8fbeffe4cd636dd9";

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, keccak256: vi.fn(() => CODE_HASH) };
});

vi.mock("../../../lib/evm-rpc", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/evm-rpc")>("../../../lib/evm-rpc");
  return { ...actual, fetchEvmRpcBatch: vi.fn() };
});

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  return { ...actual, fetchJsonWithRetry: vi.fn() };
});

vi.mock("../independent-assurance", async () => {
  const actual = await vi.importActual<typeof import("../independent-assurance")>("../independent-assurance");
  return { ...actual, fetchIndependentAssuranceReserves: vi.fn() };
});

const coin = { id: "usdgo-osl", symbol: "USDGO" } as StablecoinMeta;
const config = {
  adapter: "usdgo-transparency",
  version: 2,
  semantics: "attestation-mix",
  inputs: {
    primary: {
      kind: "http-html",
      url: "https://www.anchorage.com/platform/usdgo-reserve-attestations",
    },
  },
  params: {
    product: "USDGO",
    profile: "usdgo-v1",
    indexHost: "www.anchorage.com",
    reportHosts: ["learn.anchorage.com"],
    issuerCrossCheckUrl: "https://www.usdgo.com/api/lark-bitable",
    avalancheRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    avalancheBuidlToken: "0x53fc82f14f009009b440a706e31c9021e1196a2f",
    avalancheBuidlWallet: "0xc1d56e817d8f6c53d42ed50ed0d789eeb1495b5e",
    avalancheBuidlBlock: REPORT_BLOCK,
    avalancheBuidlBlockHash: REPORT_BLOCK_HASH,
    expectedBuidlCodeHash: CODE_HASH,
  },
} as LiveReservesConfig;

function mockBuidl(balanceRaw = BUIDL_RAW, blockHash = REPORT_BLOCK_HASH): void {
  vi.mocked(fetchEvmRpcBatch).mockResolvedValue([
    { number: `0x${REPORT_BLOCK.toString(16)}`, hash: blockHash, timestamp: `0x${REPORT_TIMESTAMP.toString(16)}` },
    "0x6000",
    `0x${balanceRaw.toString(16).padStart(64, "0")}`,
    "0x" + "6".padStart(64, "0"),
  ]);
}

function mockIssuer(lastUpdated = "Aug 11, 2026", overrides: Record<string, unknown> = {}): void {
  vi.mocked(fetchJsonWithRetry).mockResolvedValue({
    ok: true,
    data: {
      buidlUsdM: "359.37",
      gsUsdM: "99.50",
      jltxxUsdM: "689.14",
      usdUsdM: "11.82",
      backingAssetsM: "1159.83",
      circulationSupplyMFormatted: "1157.62",
      collateralizationRatio: 100.192,
      lastUpdated,
      ...overrides,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchIndependentAssuranceReserves).mockResolvedValue({
    slices: [
      { name: "FDIC-insured bank cash", pct: 1.092853, risk: "very-low", assetClass: "bank-deposit" },
      { name: "BlackRock BUIDL", pct: 19.856381, risk: "low", coinId: "buidl-blackrock", assetClass: "fund-share" },
      { name: "Goldman Sachs STBXX (CUSIP 38151N205)", pct: 11.510182, risk: "low", assetClass: "money-market-fund" },
      { name: "JPMorgan JLTXX (CUSIP 46655R119)", pct: 67.540584, risk: "low", assetClass: "money-market-fund" },
    ],
    metadata: {
      sourceTimestamp: REPORT_TIMESTAMP,
      freshnessMode: "verified",
      collateralizationRatio: 861_072_523 / 859_224_943,
      details: { assurance: { reportUrl: "https://learn.anchorage.com/06.30.26_USDGO-Stablecoin-Attestation-Report.pdf" } },
    },
  });
  mockBuidl();
  mockIssuer();
});

describe("usdgo-transparency independent promotion", () => {
  it("uses the Deloitte report for composition and liabilities, with later issuer data only as a cross-check", async () => {
    const result = await fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal);

    expect(result.slices).toHaveLength(4);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: REPORT_TIMESTAMP,
      freshnessMode: "verified",
      totalReserveUsd: 861_072_523,
      totalAssetsUsd: 861_072_523,
      totalLiabilitiesUsd: 859_224_943,
      supplyUsd: 859_224_943,
      shareholderEquityUsd: 1_847_580,
      unknownExposurePct: 0,
      details: {
        authoritativeBasis: "Deloitte examination report; issuer API is cross-check only",
        reportSurplusUsd: 1_847_580,
      },
    });
    expect(result.metadata?.issuerCrossCheck).toMatchObject({ sourceTimestamp: expect.any(Number) });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "usdgo-issuer-cross-check-newer-period", severity: "info" }),
    ]);
  });

  it("fails closed when the pinned BUIDL balance no longer matches the examined report", async () => {
    mockBuidl(BUIDL_RAW + 2_000_000n);
    await expect(fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal)).rejects.toThrow(
      "BUIDL chain balance diverges",
    );
  });

  it("fails closed on a Rootstock-style pinned block identity drift in the BUIDL proof", async () => {
    mockBuidl(BUIDL_RAW, "0x" + "1".repeat(64));
    await expect(fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal)).rejects.toThrow(
      "BUIDL block hash drifted",
    );
  });

  it("treats a same-period issuer disagreement as fatal", async () => {
    mockIssuer("Jun 30, 2026", { buidlUsdM: "150", backingAssetsM: "950.46", circulationSupplyMFormatted: "859.224943" });
    await expect(fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal)).rejects.toThrow(
      "issuer cross-check disagrees",
    );
  });

  it("validates the promoted adapter output and registry declaration", async () => {
    const result = await fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal);
    const adapter = getReserveAdapter("usdgo-transparency");
    expect(validateAdapterOutput(result, { adapter: adapter ?? undefined }).valid).toBe(true);
    expect(adapter).toMatchObject({ evidenceClass: "independent", sourceModel: "dynamic-mix" });
  });
});
