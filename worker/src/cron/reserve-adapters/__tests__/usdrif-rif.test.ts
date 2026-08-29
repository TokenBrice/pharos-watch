import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

const HASHES: Record<string, string> = {
  "0x6000": "0x146015dd2944fa6e6d87c95119399290c52ddea7e7a09f62ef54f04ee300463a",
  "0x6001": "0x5dcd44a0907ccf27e9d5f19c9466dac15c4dba10b0f30776d531269a30cfcde3",
  "0x6002": "0xe74d8993933d2fa17f50aeadcdd26df50dc9d609463cd0987df6bdbc8bbdc252",
  "0x6003": "0xdf1ccdda002e33133f8169380e689969709477a5bc10f297fab924ac94359a3c",
  "0x6004": "0xb308c2684587c61717f55777ef4ed328cb05f0a2c93025210ae9d7e19a158ea2",
  "0x6005": "0x391df4bc67ae9a4c235ee373a183027f60451e19b7ac680a7b5e0d28447194f0",
  "0x6006": "0x64392cccf7af6a17beef7097970da802b39f177ef8a77763ca6c847c240289c4",
};

vi.mock("viem/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/utils")>();
  return {
    ...actual,
    keccak256: vi.fn((value: `0x${string}`) => HASHES[value] ?? actual.keccak256(value)),
  };
});

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/evm-rpc")>();
  return {
    ...actual,
    fetchEvmRpcBatch: vi.fn(),
    fetchEvmRpcBatchDetailed: vi.fn(),
  };
});

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return { ...actual, fetchDefiLlamaPrices: vi.fn() };
});

import { fetchEvmRpcBatch, fetchEvmRpcBatchDetailed } from "../../../lib/evm-rpc";
import { fetchDefiLlamaPrices } from "../helpers";
import { fetchUsdrifRifReserves } from "../usdrif-rif";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const RIF_BUCKET = "0xa27024ed70035e46dba712609fc2afa1c97aa36a";
const DOC_BUCKET = "0x697535055aa7afd2c280523c7b062b1f05284661";
const USDRIF = "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37";
const RIF = "0x2acc95758f8b5f583470ba265eb685a8f45fc9d5";
const DOC = "0xe700691da7b9851f2f35f8b8182c69c53ccad9db";
const RIF_IMPLEMENTATION = "0x7d41de4fe6a9c57f13032b4d5489a8b7690d3fdc";
const DOC_IMPLEMENTATION = "0x2f5b77f2ed6d6947917e4d9746108e26275b3b66";
const RIF_PEG_PROVIDER = "0x6a5b2c84e63b5c1330bf4cccff1ad6f23116cc14";
const PRICE_PROVIDER = "0x6a343488338b944c6fcc89906646fac1e8e91ce5";
const WAD = 10n ** 18n;
const RIF_COLLATERAL = 306_804_255_644_077_176_642_082_130n;
const RIF_LIABILITY = 2_260_810_732_230_115_803_372_000n;
const DOC_COLLATERAL = 2_753_999_164_279_750_237_687n;
const DOC_LIABILITY = 2_737_739_060_049_725_375_000n;
const TOTAL_SUPPLY = RIF_LIABILITY + DOC_LIABILITY;
const RIF_PRICE = 69_790_072_930_231_500n;
const DOC_PRICE = WAD;
const CONTEXT = { nowSec: 1_786_668_871 };

function word(value: bigint | string | boolean): string {
  if (typeof value === "string") return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const numeric = typeof value === "boolean" ? (value ? 1n : 0n) : value;
  return `0x${numeric.toString(16).padStart(64, "0")}`;
}

function tuple(first: bigint, second: string): string {
  return `${word(first)}${word(second).slice(2)}`;
}

const coin = {
  id: "usdrif-rif",
  symbol: "USDRIF",
  contracts: [{ chain: "rootstock", address: USDRIF, decimals: 18 }],
} as unknown as StablecoinMeta;

const config: LiveReservesConfig = {
  adapter: "moc-v3-buckets",
  version: 2,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "rootstock", rpcMode: "public-rpc" } },
  params: {
    rpcUrl: "https://public-node.rsk.co",
    fallbackRpcUrl: "https://mycrypto.rsk.co",
    confirmationDepth: 24,
    maxBlockAgeSec: 3600,
    maxFutureSkewSec: 120,
    maxMarketProtocolDivergencePct: 5,
    walletExcessInfoPct: 0.1,
    walletExcessDegradedPct: 1,
    branchMaterialityPct: 0.5,
    canonicalUsdrif: {
      address: USDRIF,
      expectedProxyCodeHash: HASHES["0x6004"],
      decimals: 18,
    },
    rifToken: { address: RIF, expectedCodeHash: HASHES["0x6005"], decimals: 18 },
    docToken: { address: DOC, expectedCodeHash: HASHES["0x6006"], decimals: 18 },
    rifBucket: {
      address: RIF_BUCKET,
      expectedProxyCodeHash: HASHES["0x6000"],
      expectedImplementationAddress: RIF_IMPLEMENTATION,
      expectedImplementationCodeHash: HASHES["0x6002"],
      collateralToken: RIF,
      collateralDecimals: 18,
      expectedPegContainerProvider: RIF_PEG_PROVIDER,
      expectedPriceProvider: PRICE_PROVIDER,
    },
    docBucket: {
      address: DOC_BUCKET,
      expectedProxyCodeHash: HASHES["0x6001"],
      expectedImplementationAddress: DOC_IMPLEMENTATION,
      expectedImplementationCodeHash: HASHES["0x6003"],
      collateralToken: DOC,
      collateralDecimals: 18,
      expectedPegContainerProvider: PRICE_PROVIDER,
      expectedPriceProvider: PRICE_PROVIDER,
    },
    sourceUrls: ["https://rifonchain.com/"],
  },
};

function pinnedBatch(blockHash = "0x" + "a".repeat(64), totalSupply = TOTAL_SUPPLY): Array<unknown> {
  const rifBranch = [
    word(RIF_COLLATERAL),
    word(0n),
    word(RIF),
    word(USDRIF),
    undefined,
    tuple(RIF_LIABILITY, RIF_PEG_PROVIDER),
    tuple(RIF_PRICE, PRICE_PROVIDER),
    word(9_470_890_716_970_523_393n),
    word(false),
    word(false),
  ];
  const docBranch = [
    word(DOC_COLLATERAL),
    word(0n),
    word(DOC),
    word(USDRIF),
    undefined,
    tuple(DOC_LIABILITY, PRICE_PROVIDER),
    word(DOC_PRICE),
    word(1_005_939_245_440_626_299n),
    word(false),
    word(false),
  ];
  return [
    { number: "0x3d0", timestamp: "0x6a7e66e3", hash: blockHash },
    "0x6000", "0x6001", "0x6002", "0x6003", "0x6004", "0x6005", "0x6006",
    word(RIF_IMPLEMENTATION), word(DOC_IMPLEMENTATION), word(totalSupply), word(18n),
    ...rifBranch,
    ...docBranch,
    word(RIF_COLLATERAL),
    word(DOC_COLLATERAL + 17_000_000_000_000_000_000n),
    word(18n), word(18n),
  ];
}

function primeMocks(options?: { blockHash?: string; closingHash?: string; totalSupply?: bigint; secondTokenResult?: string }): void {
  const targetHeader = { number: "0x3d0", timestamp: "0x6a7e66e3", hash: options?.blockHash ?? "0x" + "a".repeat(64) };
  vi.mocked(fetchEvmRpcBatch).mockImplementation(async (_chain, calls) => {
    if (calls[0]?.method === "eth_blockNumber") return ["0x3e8"];
    return [{ ...targetHeader, ...(options?.closingHash ? { hash: options.closingHash } : {}) }];
  });
  const results = pinnedBatch(options?.blockHash, options?.totalSupply);
  if (options?.secondTokenResult != null) results[16] = options.secondTokenResult;
  vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValue({
    results,
    errors: options?.secondTokenResult == null
      ? [{ index: 16, code: -32000, message: "execution reverted" }, { index: 26, code: -32000, message: "execution reverted" }]
      : [{ index: 26, code: -32000, message: "execution reverted" }],
  });
  vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([
    ["rif", 0.0697330154441257],
    ["doc", 0.9990250010953164],
  ]));
}

beforeEach(() => {
  vi.clearAllMocks();
  primeMocks();
});

describe("moc-v3-buckets USDRIF promotion", () => {
  it("reconciles both pinned MoC buckets and emits market-valued slices", async () => {
    const result = await fetchUsdrifRifReserves(coin, config, new AbortController().signal, CONTEXT);

    expect(result.slices).toEqual([
      expect.objectContaining({ sourceKey: "moc-v3-buckets:usdrif:rif", name: "RIF collateral admitted to the RIF On Chain V3 RIF bucket", risk: "high" }),
      expect.objectContaining({ sourceKey: "moc-v3-buckets:usdrif:doc", name: "DOC collateral admitted to the RIF On Chain V3 DOC bucket", coinId: "doc-money-on-chain", depType: "collateral" }),
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      sourceTimestamp: 1_786_668_771,
      unknownExposurePct: 0,
      details: {
        pinnedBlock: 976,
        branchLiabilitySumRaw: TOTAL_SUPPLY.toString(),
        oracleFreshness: expect.stringContaining("market-price agreement guard"),
      },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "moc-v3-wallet-accounting-excess", severity: "info" }),
    ]);
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("moc-v3-buckets") ?? undefined }).valid).toBe(true);
  });

  it("fails closed when the second token probe succeeds or supply reconciliation drifts", async () => {
    primeMocks({ secondTokenResult: word("0x1111111111111111111111111111111111111111") });
    await expect(fetchUsdrifRifReserves(coin, config, new AbortController().signal, CONTEXT)).rejects.toThrow("did not return both");

    primeMocks({ totalSupply: TOTAL_SUPPLY + 1n });
    await expect(fetchUsdrifRifReserves(coin, config, new AbortController().signal, CONTEXT)).rejects.toThrow("do not equal");
  });

  it("fails closed on block-hash drift and market-price divergence", async () => {
    primeMocks({ closingHash: "0x" + "b".repeat(64) });
    await expect(fetchUsdrifRifReserves(coin, config, new AbortController().signal, CONTEXT)).rejects.toThrow("target block hash changed");

    primeMocks();
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["rif", 0.2], ["doc", 1]]));
    const result = await fetchUsdrifRifReserves(coin, config, new AbortController().signal, CONTEXT);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "moc-v3-market-protocol-price-divergence", effect: "degraded" }),
    ]));
  });

  it("registers as an independent onchain-observation adapter without redemption telemetry", () => {
    expect(getReserveAdapter("moc-v3-buckets")).toMatchObject({
      evidenceClass: "independent",
      sourceModel: "dynamic-mix",
      sharedSourceMode: "none",
      redemptionTelemetry: { capacity: "none", fee: "none" },
    });
  });
});
