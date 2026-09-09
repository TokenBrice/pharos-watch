import { afterEach, describe, expect, it, vi } from "vitest";
import { getReserveAdapter } from "../index";
import type * as viemUtils from "viem/utils";
import { EIP1967_IMPLEMENTATION_SLOT } from "../onchain-identity";
import {
  expectWarningEffect,
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
  type RunAdapterOptions,
} from "./reserve-adapter.test-support";

// Sentinel runtime code whose keccak256 pins to the catalog's expected hashes;
// the real Rootstock code bytes are kilobytes and pin nothing extra.
const HASHES: Record<string, string> = {
  "0x6000": "0x146015dd2944fa6e6d87c95119399290c52ddea7e7a09f62ef54f04ee300463a", // RIF bucket proxy
  "0x6001": "0x5dcd44a0907ccf27e9d5f19c9466dac15c4dba10b0f30776d531269a30cfcde3", // DOC bucket proxy
  "0x6002": "0xdaf1fdd739f2a2030fe5e92db559631b2c0dabf28e0d97abf6e48446f73da78e", // shared bucket implementation
  "0x6003": "0x0959a24babb02d4d6c6ef27aaec9c34e824a2c55d24b13a8b3dae8401138e1c4", // canonical USDRIF proxy
  "0x6004": "0x391df4bc67ae9a4c235ee373a183027f60451e19b7ac680a7b5e0d28447194f0", // RIF token
  "0x6005": "0x64392cccf7af6a17beef7097970da802b39f177ef8a77763ca6c847c240289c4", // DOC token
};

vi.mock("viem/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof viemUtils>();
  return {
    ...actual,
    keccak256: vi.fn((value: `0x${string}`) => HASHES[value] ?? actual.keccak256(value)),
  };
});

const RIF_BUCKET = "0xa27024ed70035e46dba712609fc2afa1c97aa36a";
const DOC_BUCKET = "0x697535055aa7afd2c280523c7b062b1f05284661";
const USDRIF = "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37";
const RIF = "0x2acc95758f8b5f583470ba265eb685a8f45fc9d5";
const DOC = "0xe700691da7b9851f2f35f8b8182c69c53ccad9db";
const IMPLEMENTATION = "0x5316384be99310fdea0da0b3cc0d0bb9e7f0887f";
const RIF_PEG_PROVIDER = "0xafb1b8c320acc776c1279bcdb24ab8f84ab727a4";
const PRICE_PROVIDER = "0x6a343488338b944c6fcc89906646fac1e8e91ce5";
const ROGUE_TOKEN = "0x1111111111111111111111111111111111111111";

const HEAD_NUMBER = 1_000;
const TARGET_BLOCK = HEAD_NUMBER - 24; // catalog confirmationDepth
const TARGET_BLOCK_TAG = `0x${TARGET_BLOCK.toString(16)}`;
const PINNED_TIMESTAMP = 1_786_668_771;
const PINNED_HASH = `0x${"a".repeat(64)}`;
const NOW_SEC = PINNED_TIMESTAMP + 100;
const WAD = 10n ** 18n;
const RIF_COLLATERAL = 306_804_255_644_077_176_642_082_130n;
const RIF_LIABILITY = 2_260_810_732_230_115_803_372_000n;
const DOC_COLLATERAL = 2_753_999_164_279_750_237_687n;
const DOC_LIABILITY = 2_737_739_060_049_725_375_000n;
const TOTAL_SUPPLY = RIF_LIABILITY + DOC_LIABILITY;
const RIF_PRICE = 69_790_072_930_231_500n;
const DOC_PRICE = WAD;
const PRICE_URL = `https://coins.llama.fi/prices/current/rootstock:${RIF},rootstock:${DOC}`;

const SELECTORS = {
  nACcb: "0xf30b5614",
  qACLockedInPending: "0x5cfbe578",
  acToken: "0x25bc6c41",
  tpTokens: "0x01f1b684",
  pegContainer: "0x4b746001",
  getPACtp: "0xfadda424",
  getCglb: "0x826fcd58",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  liquidated: "0x23b98cde",
  paused: "0x5c975abb",
} as const;

function word(value: bigint | boolean | string): string {
  if (typeof value === "string") return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const numeric = typeof value === "boolean" ? (value ? 1n : 0n) : value;
  return `0x${numeric.toString(16).padStart(64, "0")}`;
}

const usdrifWord = word(USDRIF);

interface UsdrifNetworkOptions {
  /** tpTokens(1) answers with a rogue address instead of the reviewed revert. */
  secondToken?: string | undefined;
  /** Canonical totalSupply; a +1 drift breaks bucket-liability reconciliation. */
  totalSupply?: bigint | undefined;
  /** The closing block read observes this hash instead of the pinned one. */
  closingHash?: string | undefined;
  /** DefiLlama market quotes. */
  rifPrice?: number | undefined;
  docPrice?: number | undefined;
}

function usdrifNetwork(options: UsdrifNetworkOptions = {}): AdapterNetworkSpec {
  const pinnedHeader = { number: TARGET_BLOCK, timestamp: PINNED_TIMESTAMP, hash: PINNED_HASH };
  let blockReads = 0;
  const rpc: Record<string, AdapterRpcValue> = {
    eth_blockNumber: HEAD_NUMBER,
    [`eth_getBlockByNumber:${TARGET_BLOCK_TAG}`]: () => {
      blockReads += 1;
      return options.closingHash && blockReads > 1 ? { ...pinnedHeader, hash: options.closingHash } : pinnedHeader;
    },
    [`${RIF_BUCKET}:${EIP1967_IMPLEMENTATION_SLOT}`]: word(IMPLEMENTATION),
    [`${DOC_BUCKET}:${EIP1967_IMPLEMENTATION_SLOT}`]: word(IMPLEMENTATION),
    [`${USDRIF}:${SELECTORS.totalSupply}`]: options.totalSupply ?? TOTAL_SUPPLY,
    [`${USDRIF}:${SELECTORS.decimals}`]: 18n,
    [`${RIF}:${SELECTORS.balanceOf}${word(RIF_BUCKET).slice(2)}`]: RIF_COLLATERAL,
    [`${DOC}:${SELECTORS.balanceOf}${word(DOC_BUCKET).slice(2)}`]: DOC_COLLATERAL + 17_000_000_000_000_000_000n,
    [`${RIF}:${SELECTORS.decimals}`]: 18n,
    [`${DOC}:${SELECTORS.decimals}`]: 18n,
    // Reviewed invariant: tpTokens(1) reverts on both buckets (sole tracked token).
    [`${SELECTORS.tpTokens}${word(1n).slice(2)}`]: options.secondToken == null ? null : word(options.secondToken),
  };
  const buckets = [
    {
      address: RIF_BUCKET,
      collateralToken: RIF,
      collateral: RIF_COLLATERAL,
      liability: RIF_LIABILITY,
      pegProvider: RIF_PEG_PROVIDER,
      priceAnswer: `${word(RIF_PRICE)}${word(PRICE_PROVIDER).slice(2)}`,
      coverage: 9_470_890_716_970_523_393n,
    },
    {
      address: DOC_BUCKET,
      collateralToken: DOC,
      collateral: DOC_COLLATERAL,
      liability: DOC_LIABILITY,
      pegProvider: PRICE_PROVIDER,
      priceAnswer: word(DOC_PRICE),
      coverage: 1_005_939_245_440_626_299n,
    },
  ] as const;
  for (const bucket of buckets) {
    Object.assign(rpc, {
      [`${bucket.address}:${SELECTORS.nACcb}`]: bucket.collateral,
      [`${bucket.address}:${SELECTORS.qACLockedInPending}`]: 0n,
      [`${bucket.address}:${SELECTORS.acToken}`]: bucket.collateralToken,
      [`${bucket.address}:${SELECTORS.tpTokens}${word(0n).slice(2)}`]: usdrifWord,
      [`${bucket.address}:${SELECTORS.pegContainer}${word(0n).slice(2)}`]:
        `${word(bucket.liability)}${word(bucket.pegProvider).slice(2)}`,
      [`${bucket.address}:${SELECTORS.getPACtp}${usdrifWord.slice(2)}`]: bucket.priceAnswer,
      [`${bucket.address}:${SELECTORS.getCglb}`]: bucket.coverage,
      [`${bucket.address}:${SELECTORS.liquidated}`]: false,
      [`${bucket.address}:${SELECTORS.paused}`]: false,
    });
  }
  return {
    rpc,
    code: {
      [RIF_BUCKET]: "0x6000",
      [DOC_BUCKET]: "0x6001",
      [IMPLEMENTATION]: "0x6002",
      [USDRIF]: "0x6003",
      [RIF]: "0x6004",
      [DOC]: "0x6005",
    },
    json: {
      [PRICE_URL]: {
        coins: {
          [`rootstock:${RIF}`]: {
            price: options.rifPrice ?? 0.0697330154441257,
            timestamp: NOW_SEC - 60,
            confidence: 0.99,
          },
          [`rootstock:${DOC}`]: {
            price: options.docPrice ?? 0.9990250010953164,
            timestamp: NOW_SEC - 60,
            confidence: 0.99,
          },
        },
      },
    },
  };
}

async function runUsdrif(options: UsdrifNetworkOptions & RunAdapterOptions = {}) {
  const { secondToken, totalSupply, closingHash, rifPrice, docPrice, ...runOptions } = options;
  return runAdapter("moc-v3-buckets", "usdrif-rif", {
    network: usdrifNetwork({ secondToken, totalSupply, closingHash, rifPrice, docPrice }),
    nowSec: NOW_SEC,
    ...runOptions,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("moc-v3-buckets USDRIF promotion", () => {
  it("reconciles both pinned MoC buckets and emits market-valued slices", async () => {
    const { result } = await runUsdrif();

    expect(result.slices).toEqual([
      expect.objectContaining({
        sourceKey: "moc-v3-buckets:usdrif:rif",
        name: "RIF collateral admitted to the RIF On Chain V3 RIF bucket",
        risk: "high",
      }),
      expect.objectContaining({
        sourceKey: "moc-v3-buckets:usdrif:doc",
        name: "DOC collateral admitted to the RIF On Chain V3 DOC bucket",
        coinId: "doc-money-on-chain",
        depType: "collateral",
      }),
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      sourceTimestamp: PINNED_TIMESTAMP,
      unknownExposurePct: 0,
      details: {
        pinnedBlock: TARGET_BLOCK,
        pinnedBlockHash: PINNED_HASH,
        branchLiabilitySumRaw: TOTAL_SUPPLY.toString(),
        oracleFreshness: expect.stringContaining("market-price agreement guard"),
      },
    });
    expectWarnings(result, ["moc-v3-wallet-accounting-excess"]);
  });

  it("fails closed when the second token probe succeeds or supply reconciliation drifts", async () => {
    await expect(runUsdrif({ secondToken: ROGUE_TOKEN })).rejects.toThrow("did not return both");
    await expect(runUsdrif({ totalSupply: TOTAL_SUPPLY + 1n })).rejects.toThrow("do not equal");
  });

  it("fails closed on block-hash drift and market-price divergence", async () => {
    await expect(runUsdrif({ closingHash: `0x${"b".repeat(64)}` })).rejects.toThrow("target block hash changed");

    const { result } = await runUsdrif({ rifPrice: 0.2, docPrice: 1 });
    expectWarningEffect(result, "moc-v3-market-protocol-price-divergence", "degraded");
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
