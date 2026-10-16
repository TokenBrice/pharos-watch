/**
 * Corpus replay gate.
 *
 * Every registered adapter either replays a captured or explicitly synthetic
 * payload through the shared harness — proving `validateAdapterOutput` passes
 * and the emitted `freshnessMode` is one the descriptor admits — or carries a
 * reviewed exemption reason. Numeric rows also pin independent composition and
 * telemetry expectations. Each replayed adapter proves that an upstream failure
 * surfaces as an error or a `degraded` warning, not a plausible wrong snapshot.
 */
import { afterAll, describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import usdx from "@shared/data/stablecoins/coins/usdx-kava.json";
import { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey, type LiveReserveWarning } from "@shared/types/live-reserves";
import { CORPUS_BACKLOG as CAPTURE_BACKLOG, CORPUS_CASES as CAPTURE_CASES, CORPUS_NOT_REPLAYABLE, type AdapterCorpusCase } from "./adapter-corpus.test-support";
import { AFI_PROOF_PAYLOAD } from "./afi-proof.test-support";
import { MEGAUSD_BACKING, MEGAUSD_URL } from "./megausd-custody.test-support";
import { NOW_SEC as LIQUITY_NOW_SEC, TROVE_MANAGER, v1Network } from "./liquity-v1.test-support";
import { BLOCK_TIME_SEC as KAVA_BLOCK_TIME_SEC, KAVA_LCD_FIXTURES, TOTAL_COLLATERAL_URL, kavaNetwork } from "./kava-cdp.test-support";
import { BALANCE_SHEET_ENDPOINT, BALANCE_SHEET_SAMPLE } from "./frax.test-support";
import { UNITED_POR_ENDPOINT, UNITED_POR_PAYLOAD } from "./united-por.test-support";
import { ZEPHYR_ENDPOINT, ZEPHYR_CAPTURE } from "./zephyr-scanner.test-support";
import type { AdapterResult } from "../types";
// Keep numeric-contract source ownership explicit alongside registered replay.
import "../afi-proof";
import "../blast-usdb-yield-manager";
import "../custody-inventory";
import "../liquity-v1";
import "../kava-cdp";
import "../frax";
import "../united-por";
import "../superstate-liquidity";
import "../zephyr-scanner";
import { runAdapter, type AdapterNetworkRequest, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

interface NumericAdapterCorpusCase extends AdapterCorpusCase {
  coin?: StablecoinMeta;
  expected?: {
    slices: AdapterResult["slices"];
    metadata: Record<string, unknown>;
    warnings: Pick<LiveReserveWarning, "code" | "effect" | "severity">[];
    absentMetadata: readonly string[];
    warningsUndefined?: boolean;
    requestUrls?: readonly string[];
    requestIncludes?: readonly AdapterNetworkRequest[];
    displayUrl?: string;
  };
  drift: AdapterCorpusCase["drift"] & { error?: RegExp; nowSec?: number };
}

const AFI_ENDPOINT = "https://api.afiprotocol.xyz/por/multipli/rwaUSDi/proofs";
const BLAST_YIELD_MANAGER = "0xa230285d5683c74935ad14c446e137c8c8828438";
const BLAST_USDB = "0x4300000000000000000000000000000000000003";
const BLAST_SUPPLY_RPC = {
  [`${BLAST_USDB}:0x18160ddd`]: 100n * 10n ** 18n,
  [`${BLAST_USDB}:0x313ce567`]: 18n,
};
const SUPERSTATE_LIQUIDITY_URL = "https://api.superstate.com/v1/funds/liquidity";
const SUPERSTATE_ORACLE = "0x289B5036cd942e619E1Ee48670F98d214E745AAC";
const SUPERSTATE_TOKEN = "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e";
const SUPERSTATE_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SUPERSTATE_LATEST_ROUND = `0x${[
  1n,
  1_015_000_000n,
  1_757_000_000n,
  1_757_000_000n,
  1n,
].map((word) => word.toString(16).padStart(64, "0")).join("")}`;

// Synthetic RPC values retained from superstate-liquidity.test.ts.
function superstateNetwork(payload: unknown): AdapterNetworkSpec {
  return {
    json: { [SUPERSTATE_LIQUIDITY_URL]: payload },
    rpc: {
      [`${SUPERSTATE_TOKEN}:decimals()`]: 18n,
      [`${SUPERSTATE_TOKEN}:totalSupply()`]: 1_000_000n * 10n ** 18n,
      [`${SUPERSTATE_ORACLE}:decimals()`]: 8n,
      [`${SUPERSTATE_ORACLE}:latestRoundData()`]: SUPERSTATE_LATEST_ROUND,
      [`${SUPERSTATE_USDC}:balanceOf(address)`]: 9_310_000_000000n,
    },
    block: { number: 23_000_000, timestamp: 1_757_000_000 },
  };
}

const NUMERIC_CORPUS_CASES: Record<string, NumericAdapterCorpusCase> = {
  // Full proof payload moved unchanged from afi-proof.test.ts.
  "afi-proof": {
    coinId: "rwausdi-multipli",
    nowSec: 1_788_978_660,
    network: { json: { [AFI_ENDPOINT]: AFI_PROOF_PAYLOAD } },
    expected: {
      slices: [{
        name: "Institutional credit and market-neutral fund basket",
        sourceKey: "afi-proof:aggregate",
        pct: 100,
        risk: "high",
        assetClass: "other",
        issuerOrObligor: expect.any(String),
      }],
      metadata: {
        totalReserveUsd: 1_500_000_000,
        totalLiabilitiesUsd: 479_782_100,
        collateralizationRatio: expect.closeTo(1_500_000_000 / 479_782_100, 9),
        unknownExposurePct: 100,
        freshnessMode: "unverified",
        details: { proofId: "fa575eeac9391401", opaqueBasket: true, active: true },
      },
      warnings: [{ code: "opaque-reserve-basket", effect: "info", severity: "info" }],
      absentMetadata: [],
    },
    drift: {
      label: "the proof endpoint returns HTTP 500",
      network: { json: { [AFI_ENDPOINT]: { status: 500, json: {} } } },
      outcome: "error",
    },
  },
  // Synthetic RPC values retained from blast-usdb-yield-manager.test.ts.
  "blast-usdb-yield-manager": {
    coinId: "usdb-blast",
    nowSec: 1_788_912_032,
    network: { rpc: { [`ethereum:${BLAST_YIELD_MANAGER}:0xd4c3eea0`]: 120n * 10n ** 18n, ...BLAST_SUPPLY_RPC } },
    expected: {
      slices: [{
        sourceKey: "blast-usdb-yield-manager:dai",
        name: "MakerDAO DSR / DAI yield manager",
        pct: 100,
        risk: "low",
        coinId: "dai-makerdao",
        depType: "mechanism",
      }],
      metadata: {
        freshnessMode: "not-applicable",
        totalReserveUsd: 120,
        supplyUsd: 100,
        details: {
          proofKind: "blast-usdb-yield-manager-total-value",
          supplyChain: "blast",
          sharePrice: 1.2,
        },
      },
      warnings: [],
      absentMetadata: ["collateralizationRatio"],
    },
    drift: {
      label: "the manager totalValue read is unavailable",
      network: { rpc: { [`ethereum:${BLAST_YIELD_MANAGER}:0xd4c3eea0`]: null, ...BLAST_SUPPLY_RPC } },
      outcome: "error",
      error: /totalValue/,
    },
  },
  "megausd-custody": {
    coinId: "usdm-mega",
    coin: {
      id: "usdm-mega",
      name: "MegaUSD",
      ticker: "USDM",
      liveReservesConfig: {
        adapter: "megausd-custody",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url: MEGAUSD_URL } },
      },
    } as unknown as StablecoinMeta,
    nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
    network: { json: { [MEGAUSD_URL]: MEGAUSD_BACKING } },
    expected: {
      slices: [
        { sourceKey: "megausd-custody:usdc", name: "USDC cash-equivalent reserves", pct: 99.9, risk: "low", coinId: "usdc-circle", depType: "collateral" },
        { sourceKey: "megausd-custody:usdtb", name: "USDtb cash-equivalent reserves", pct: 0.1, risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
      ],
      metadata: {
        sourceTimestamp: Math.floor(Date.parse("2026-09-09T15:55:59.000Z") / 1000),
        freshnessMode: "verified",
        totalReserveUsd: expect.closeTo(16_960_291.2657021, 3),
        details: { lastUpdatedAt: "2026-09-09T15:55:59.000Z" },
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: ["collateralizationRatio", "supplyUsd"],
      requestUrls: [MEGAUSD_URL],
    },
    drift: {
      label: "the custody endpoint returns HTTP 500",
      network: { json: { [MEGAUSD_URL]: { status: 500, body: "upstream unavailable" } } },
      outcome: "error",
      error: /500/,
    },
  },
  // Synthetic same-run RPC and price values retained from liquity-v1.test.ts.
  "liquity-v1": {
    coinId: "lusd-liquity",
    nowSec: LIQUITY_NOW_SEC,
    network: v1Network(),
    expected: {
      slices: [{ sourceKey: "liquity-v1:eth", name: "ETH", pct: 100, risk: "very-low" }],
      metadata: {
        freshnessMode: "not-applicable",
        chain: "ethereum",
        troveManagerAddress: TROVE_MANAGER,
        totalCollateralRaw: "200000000000000000000",
        totalDebtRaw: "150000000000000000000000",
        totalDebtUsd: 150_000,
        totalCollateralUsd: 400_000,
        ethPriceUsd: 2000,
        minimumCollateralRatio: 1.1,
        collateralizationRatio: expect.closeTo(2.667, 2),
        totalCollateralRatio: expect.closeTo(2.667, 2),
        redemption: {
          capacityUsd: 150_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "open",
          routeStatusSource: "onchain",
          holderEligibility: "any-holder",
          settlementDelaySec: 0,
          feeBps: 50,
        },
        details: {
          proofKind: "liquity-v1-system-collateral",
          protocolPriceRaw: "2000000000000000000000",
          mcrRaw: "1100000000000000000",
        },
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: ["redemption.routeStatusReason"],
    },
    drift: {
      label: "the batched TroveManager read is unavailable",
      network: { ...v1Network(), multicall: false },
      outcome: "error",
    },
  },
  "kava-cdp": {
    coinId: "usdx-kava",
    coin: {
      id: "usdx-kava",
      name: "USDX",
      symbol: "USDX",
      liveReservesConfig: structuredClone(usdx.liveReservesConfig),
    } as unknown as StablecoinMeta,
    nowSec: KAVA_BLOCK_TIME_SEC,
    network: kavaNetwork(),
    expected: {
      // Detailed unit/pricing oracles also remain in the pure Kava suite.
      slices: expect.arrayContaining([
        expect.objectContaining({ name: "HBTC", risk: "medium", pct: expect.closeTo(80.2, 9), sourceKey: "kava-cdp:hbtc" }),
        expect.objectContaining({ name: "BTCB", risk: "medium" }),
        expect.objectContaining({ name: "XRPB", risk: "medium" }),
        expect.objectContaining({ name: "KAVA", risk: "high" }),
        expect.objectContaining({ name: "BNB", risk: "high" }),
        expect.objectContaining({ name: "BUSD", risk: "low", pct: expect.closeTo(1.4, 9) }),
        expect.objectContaining({ name: "USDT", risk: "low", pct: expect.closeTo(0.2, 9) }),
      ]),
      metadata: { freshnessMode: "not-applicable", totalReserveUsd: expect.closeTo(63_740_454.117967, 6) },
      warnings: [],
      absentMetadata: [],
      requestUrls: Object.keys(KAVA_LCD_FIXTURES),
      displayUrl: TOTAL_COLLATERAL_URL,
    },
    drift: {
      label: "the required totalCollateral endpoint returns HTTP 503",
      network: kavaNetwork({ [TOTAL_COLLATERAL_URL]: { status: 503, body: "upstream unavailable" } }),
      outcome: "error",
      error: /503/,
    },
  },
  "frax-balance-sheet": {
    coinId: "frax-frax",
    nowSec: 1_775_307_827 + 3_600,
    network: { json: { [BALANCE_SHEET_ENDPOINT]: BALANCE_SHEET_SAMPLE } },
    expected: {
      slices: expect.arrayContaining([
        expect.objectContaining({ name: "USTB (Superstate tokenized T-bills)", coinId: "ustb-superstate" }),
      ]),
      metadata: {
        sourceTimestamp: 1_775_307_827,
        freshnessMode: "verified",
        totalCollateralUsd: 123_010_191,
        sourceTotalAssetsUsd: 123_010_191,
        assetCount: 5,
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: [],
      requestUrls: [BALANCE_SHEET_ENDPOINT],
    },
    drift: {
      label: "the balance-sheet response loses its asset rows",
      nowSec: 1_775_657_027,
      network: { json: { [BALANCE_SHEET_ENDPOINT]: { ...BALANCE_SHEET_SAMPLE, assets: [] } } },
      outcome: "error",
      error: /missing or empty assets/,
    },
  },
  "united-por": {
    coinId: "u-united-stables",
    nowSec: Math.floor(Date.parse("2026-07-09T16:10:01.559Z") / 1000) + 3_600,
    network: { json: { [UNITED_POR_ENDPOINT]: UNITED_POR_PAYLOAD } },
    expected: {
      slices: [{
        sourceKey: "united-por:total-reserve",
        name: "Cash, U.S. Treasury bills, and fiat-referenced stablecoins (variable mix)",
        risk: "low",
        pct: 100,
      }],
      metadata: {
        sourceTimestamp: Math.floor(Date.parse("2026-07-09T16:10:01.559Z") / 1000),
        freshnessMode: "verified",
        totalReserveUsd: 1038136298.86,
        supplyUsd: 1030959209.0,
        collateralizationRatio: expect.closeTo(1038136298.86 / 1030959209.0, 9),
        details: { accountName: "United Stables", ripcord: false },
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: ["details.ripcordDetails"],
    },
    drift: {
      label: "the required catalog PoR endpoint returns HTTP 503",
      network: { json: { [UNITED_POR_ENDPOINT]: { status: 503, body: "upstream down" } } },
      outcome: "error",
      error: /503/,
    },
  },
  "superstate-liquidity": {
    coinId: "ustb-superstate",
    nowSec: 1_757_000_100,
    network: superstateNetwork({
      USTB: {
        circle_usd_available_amount: "2696887.17",
        usdc_redemption_idle_balance: "3412248.944618",
      },
    }),
    expected: {
      slices: [{
        sourceKey: "chainlink-nav:token:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e",
        name: "Invesco Short Duration US Government Securities Fund (USTB) shares",
        pct: 100,
        risk: "very-low",
      }],
      metadata: {
        sourceTimestamp: 1_757_000_000,
        freshnessMode: "verified",
        redemption: {
          capacityUsd: 9_310_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "unknown",
          routeStatusSource: "static-config",
        },
      },
      warnings: [],
      absentMetadata: ["redemption.sourceTimestamp"],
      requestIncludes: [{ url: SUPERSTATE_LIQUIDITY_URL, method: "GET" }],
    },
    drift: {
      label: "the required liquidity payload renames circle_usd_available_amount",
      network: superstateNetwork({ USTB: { usdc_redemption_idle_balance: "3412248.944618" } }),
      outcome: "error",
      error: /circle_usd_available_amount/,
    },
  },
  "zephyr-scanner": {
    coinId: "zsd-zephyr-protocol",
    nowSec: 1_710_003_600,
    network: { json: { [ZEPHYR_ENDPOINT]: ZEPHYR_CAPTURE } },
    expected: {
      slices: [expect.objectContaining({
        name: "ZEPH protocol reserve",
        pct: 100,
        risk: "high",
        assetClass: "cryptoasset",
        liquidityHorizon: "unknown",
        riskFactors: ["smart-contract", "market", "liquidity", "concentration", "custody"],
      })],
      metadata: {
        sourceTimestamp: 1_710_000_000,
        freshnessMode: "verified",
        reserveHeight: 773_828,
        totalReserveUsd: 1_221_858.9661031931,
        supplyUsd: 385_036.81291444064,
        collateralizationRatio: 3.173356,
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: [],
    },
    drift: {
      // Each quantity has paired encodings: all supply encodings must be
      // absent before this is a dropped datum, not just one representation.
      label: "the snapshot drops every circulating-supply encoding",
      network: { json: { [ZEPHYR_ENDPOINT]: {
        ...ZEPHYR_CAPTURE,
        results: [{
          ...ZEPHYR_CAPTURE.results[0]!,
          on_chain: { ...ZEPHYR_CAPTURE.results[0]!.on_chain, zsd_circ: undefined, zsd_circ_atoms: undefined },
          raw: { ...ZEPHYR_CAPTURE.results[0]!.raw, num_stables: undefined, liabilities: undefined },
        }],
      } } },
      outcome: "error",
      error: /ZSD supply USD|zsd_circ/,
    },
  },
};
const CORPUS_CASES: Record<string, NumericAdapterCorpusCase> = { ...CAPTURE_CASES, ...NUMERIC_CORPUS_CASES };
// The shared capture inventory is read-only; these replay owners now live here.
const CORPUS_BACKLOG = Object.fromEntries(
  Object.entries(CAPTURE_BACKLOG).filter(([key]) => NUMERIC_CORPUS_CASES[key] === undefined),
);
const caseEntries = Object.entries(CORPUS_CASES) as [LiveReserveAdapterKey, NumericAdapterCorpusCase][];

// Highest raw upstream percentage drift (metadata.diag.rawSumDeviation) each
// replayed producer emits, so a corpus run doubles as a drift detector.
const rawSumDeviationByAdapter = new Map<LiveReserveAdapterKey, number>();

describe("adapter corpus replay", () => {
  it("routes every adapter key to a corpus case or a reviewed exemption", () => {
    const uncovered = LIVE_RESERVE_ADAPTER_KEYS.filter(
      (key) =>
        CORPUS_CASES[key] === undefined &&
        CORPUS_NOT_REPLAYABLE[key] === undefined &&
        CORPUS_BACKLOG[key] === undefined,
    );
    expect(uncovered, "add a corpus case or a CORPUS_NOT_REPLAYABLE/CORPUS_BACKLOG reason for these adapter keys").toEqual([]);

    const doubleBooked = Object.keys(CORPUS_CASES).filter(
      (key) => CORPUS_NOT_REPLAYABLE[key] !== undefined || CORPUS_BACKLOG[key] !== undefined,
    );
    expect(doubleBooked, "an adapter with a corpus case must not also be exempt").toEqual([]);

    const crossListed = Object.keys(CORPUS_NOT_REPLAYABLE).filter((key) => CORPUS_BACKLOG[key] !== undefined);
    expect(crossListed, "a structural exemption must not also be backlog debt").toEqual([]);

    const knownKeys = new Set<string>(LIVE_RESERVE_ADAPTER_KEYS);
    const stale = [
      ...Object.keys(CORPUS_CASES),
      ...Object.keys(CORPUS_NOT_REPLAYABLE),
      ...Object.keys(CORPUS_BACKLOG),
    ].filter((key) => !knownKeys.has(key));
    expect(stale, "corpus entries name adapter keys that no longer exist").toEqual([]);

    const backlogKeys = Object.keys(CORPUS_BACKLOG).sort();
    // Vitest swallows console.* on green runs; process.stdout.write lands the
    // debt report in the test output either way.
    process.stdout.write(
      `corpus backlog: ${backlogKeys.length} adapter(s) still owe a committed wire capture\n` +
        backlogKeys.map((key) => `  - ${key}`).join("\n") +
        "\n",
    );
  });

  it.each(caseEntries)("%s replays its payload into an admissible snapshot", async (key, corpusCase) => {
    const { result, network, config } = await runAdapter(key, corpusCase.coin ?? corpusCase.coinId, {
      network: corpusCase.network,
      nowSec: corpusCase.nowSec,
    });

    expect(result.slices.length).toBeGreaterThan(0);
    if (corpusCase.expected) {
      const { expected } = corpusCase;
      expect(result.slices).toEqual(expected.slices);
      expect(result.metadata).toMatchObject(expected.metadata);
      expect((result.warnings ?? []).map(({ code, effect, severity }) => ({ code, effect, severity })))
        .toEqual(expected.warnings);
      for (const path of expected.absentMetadata) {
        expect(result.metadata).not.toHaveProperty(path);
      }
      if (expected.warningsUndefined) expect(result.warnings).toBeUndefined();
      if (expected.requestUrls) {
        expect(network.requests.map((request) => request.url)).toEqual(expected.requestUrls);
      }
      for (const request of expected.requestIncludes ?? []) {
        expect(network.requests).toContainEqual(request);
      }
      if (expected.displayUrl) expect(config.display?.url).toBe(expected.displayUrl);
    }
    const rawSumDeviation = result.metadata?.diag?.rawSumDeviation;
    if (typeof rawSumDeviation === "number") {
      const previous = rawSumDeviationByAdapter.get(key);
      if (previous === undefined || rawSumDeviation > previous) {
        rawSumDeviationByAdapter.set(key, rawSumDeviation);
      }
    }
    const declaration = LIVE_RESERVE_ADAPTER_DEFINITIONS[key];
    const allowedFreshnessModes = "validation" in declaration
      ? declaration.validation.allowedFreshnessModes
      : undefined;
    if (allowedFreshnessModes && result.metadata?.freshnessMode) {
      expect(allowedFreshnessModes as readonly string[]).toContain(result.metadata.freshnessMode);
    }
  });

  it.each(caseEntries)("%s surfaces upstream failure or shape drift instead of publishing it", async (key, corpusCase) => {
    const { drift } = corpusCase;
    const run = await runAdapter(key, corpusCase.coin ?? corpusCase.coinId, {
      network: drift.network,
      nowSec: drift.nowSec ?? corpusCase.nowSec,
      validate: false,
    }).then(
      (value) => ({ status: "ok" as const, value }),
      (error: unknown) => ({ status: "error" as const, error }),
    );

    if (drift.outcome === "error") {
      expect(run.status, `${key}: ${drift.label} published a snapshot instead of failing`).toBe("error");
      if (corpusCase.expected && run.status === "error") {
        expect(run.error).toBeInstanceOf(Error);
        if (drift.error) expect(run.error).toHaveProperty("message", expect.stringMatching(drift.error));
      }
      return;
    }

    expect(run.status, `${key}: ${drift.label} threw; the corpus expects a degraded publication`).toBe("ok");
    if (run.status !== "ok") return;
    const warnings = [...(run.value.result.warnings ?? []), ...run.value.report.warnings];
    const degrading = warnings.filter((warning) => warning.effect === "degraded" || warning.effect === "fatal");
    expect(
      degrading.map((warning) => warning.code),
      `${key}: ${drift.label} published silently — no degraded warning`,
    ).not.toEqual([]);
  });

  afterAll(() => {
    const rows = [...rawSumDeviationByAdapter.entries()].sort(([left], [right]) => left.localeCompare(right));
    if (rows.length === 0) return;
    const table = rows
      .map(([adapter, max]) => `  ${adapter.padEnd(28)} ${max.toFixed(6)} pct-points`)
      .join("\n");
    // Vitest swallows console.* on green runs; process.stdout.write lands the
    // drift table in the test output either way.
    process.stdout.write(`adapter corpus rawSumDeviation (max per producer, replayed fixtures):\n${table}\n`);
  });
});
