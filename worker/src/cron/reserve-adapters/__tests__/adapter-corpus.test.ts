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
import { describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey, type LiveReserveWarning } from "@shared/types/live-reserves";
import {
  buildG6FaultRows, CORPUS_BACKLOG as CAPTURE_BACKLOG, CORPUS_CASES as CAPTURE_CASES, CORPUS_NOT_REPLAYABLE,
  createG6CleanBaselineLoader, runG6FaultTargets, type G6FaultVector,
} from "./adapter-corpus.test-support";
import { NUMERIC_CORPUS_FIXTURES, SUPERSTATE_LIQUIDITY_URL, type NumericCorpusFixture } from "./fixtures/numeric-corpus-fixtures";
import { MEGAUSD_URL } from "./megausd-custody.test-support";
import { TROVE_MANAGER } from "./liquity-v1.test-support";
import { KAVA_LCD_FIXTURES, TOTAL_COLLATERAL_URL } from "./kava-cdp.test-support";
import { BALANCE_SHEET_ENDPOINT } from "./frax.test-support";
import { MONOLITH_LENDER_PIN } from "./monolith-lender.test-support";
import type { AdapterResult } from "../types";
import m0SolanaCapture from "./fixtures/m0-solana-local-2026-10-21.json";
// Keep numeric-contract source ownership explicit alongside registered replay.
import "../blast-usdb-yield-manager";
import "../custody-inventory";
import "../liquity-v1";
import "../kava-cdp";
import "../frax";
import "../united-por";
import "../superstate-liquidity";
import "../zephyr-scanner";
import "../m0-solana-wrapper";
import { runAdapter, type AdapterNetworkRequest } from "./reserve-adapter.test-support";

interface NumericAdapterCorpusCase extends NumericCorpusFixture {
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
}

const NUMERIC_CORPUS_CASES: Record<string, NumericAdapterCorpusCase> = {
  "monolith-lender": {
    ...NUMERIC_CORPUS_FIXTURES["monolith-lender"],
    expected: {
      slices: [
        expect.objectContaining({
          sourceKey: `monolith-lender:ethereum:${MONOLITH_LENDER_PIN.collateral}`,
          name: "wstETH collateral (Monolith Lender)",
          pct: expect.closeTo(90.30498446704837, 8),
          risk: "low",
        }),
        expect.objectContaining({
          sourceKey: `monolith-lender:ethereum:${MONOLITH_LENDER_PIN.psmVault}`,
          name: "sUSDS PSM reserve (Monolith Lender)",
          pct: expect.closeTo(9.695015532951636, 8),
          risk: "low",
          coinId: "susds-sky",
          depType: "collateral",
        }),
      ],
      metadata: {
        freshnessMode: "not-applicable",
        supplyTokens: expect.closeTo(420092.200246431, 5),
        totalDebtUsd: expect.closeTo(355887.0069934302, 6),
        collateralizationRatio: expect.closeTo(1.68043314, 8),
        unknownExposurePct: 0,
        redemption: {
          capacityUsd: expect.closeTo(64205.19325300078, 6),
          capacityKind: "live-direct",
          freshnessKind: "same-run-onchain",
          routeStatus: "open",
          routeStatusSource: "onchain",
          holderEligibility: "any-holder",
          feeBps: 0,
          blockNumber: MONOLITH_LENDER_PIN.blockNumber,
          outputAssetKeys: ["usds-sky"],
        },
      },
      warnings: [],
      absentMetadata: ["sourceTimestamp"],
    },
  },
  "m0-solana-wrapper": {
    ...NUMERIC_CORPUS_FIXTURES["m0-solana-wrapper"],
    expected: {
      slices: [{
        sourceKey: "m0-solana-wrapper:m-vault",
        name: expect.any(String),
        pct: 100,
        risk: "low",
        coinId: "m-m0",
        depType: "wrapper",
        assetClass: "stablecoin",
      }],
      metadata: {
        freshnessMode: "not-applicable",
        observedBlock: { chain: "solana", number: m0SolanaCapture.block.slot, timestamp: m0SolanaCapture.block.timestamp },
        totalSupplyRaw: "23939622844939",
        underlyingBalanceRaw: "22255150855475",
        indexedUnderlyingBalanceRaw: "24441457026511",
        underlyingMultiplier: 1.098238209448,
        collateralizationRatio: expect.closeTo(1.0209624932198167, 12),
        unknownExposurePct: 0,
      },
      warnings: [{ code: "m0-local-wrapper-scope", effect: "info", severity: "info" }],
      absentMetadata: ["redemption"],
    },
  },
  // Synthetic RPC values retained from blast-usdb-yield-manager.test.ts.
  "blast-usdb-yield-manager": {
    ...NUMERIC_CORPUS_FIXTURES["blast-usdb-yield-manager"],
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
  },
  "megausd-custody": {
    ...NUMERIC_CORPUS_FIXTURES["megausd-custody"],
    expected: {
      slices: [
        { sourceKey: "megausd-custody:usdc", name: "USDC cash-equivalent reserves", pct: expect.closeTo(99.87667757992814, 8), risk: "low", coinId: "usdc-circle", depType: "collateral" },
        { sourceKey: "megausd-custody:usdtb", name: "USDtb cash-equivalent reserves", pct: expect.closeTo(0.12332242007185923, 8), risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
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
  },
  // Synthetic same-run RPC and price values retained from liquity-v1.test.ts.
  "liquity-v1": {
    ...NUMERIC_CORPUS_FIXTURES["liquity-v1"],
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
  },
  "kava-cdp": {
    ...NUMERIC_CORPUS_FIXTURES["kava-cdp"],
    expected: {
      // Detailed unit/pricing oracles also remain in the pure Kava suite.
      slices: expect.arrayContaining([
        expect.objectContaining({ name: "HBTC", risk: "medium", pct: expect.closeTo(80.21670453644832, 8), sourceKey: "kava-cdp:hbtc" }),
        expect.objectContaining({ name: "BTCB", risk: "medium", pct: expect.closeTo(7.721250969745951, 8) }),
        expect.objectContaining({ name: "XRPB", risk: "medium", pct: expect.closeTo(3.8375869436432217, 8) }),
        expect.objectContaining({ name: "KAVA", risk: "high", pct: expect.closeTo(3.807252905946823, 8) }),
        expect.objectContaining({ name: "BNB", risk: "high", pct: expect.closeTo(2.9032914244728696, 8) }),
        expect.objectContaining({ name: "BUSD", risk: "low", pct: expect.closeTo(1.3526381503986986, 8) }),
        expect.objectContaining({ name: "USDT", risk: "low", pct: expect.closeTo(0.161275069344107, 8) }),
      ]),
      metadata: { freshnessMode: "not-applicable", totalReserveUsd: expect.closeTo(63_740_454.117967, 6) },
      warnings: [],
      absentMetadata: [],
      requestUrls: Object.keys(KAVA_LCD_FIXTURES),
      displayUrl: TOTAL_COLLATERAL_URL,
    },
  },
  "frax-balance-sheet": {
    ...NUMERIC_CORPUS_FIXTURES["frax-balance-sheet"],
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
  },
  "united-por": {
    ...NUMERIC_CORPUS_FIXTURES["united-por"],
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
        details: { accountName: "United Stables", ripcord: false, freshnessSource: "same-run-render-clock" },
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: ["details.ripcordDetails"],
    },
  },
  "superstate-liquidity": {
    ...NUMERIC_CORPUS_FIXTURES["superstate-liquidity"],
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
      warnings: [expect.objectContaining({ code: "por-supply-chain-omitted", effect: "info" })],
      absentMetadata: ["redemption.sourceTimestamp"],
      requestIncludes: [{ url: SUPERSTATE_LIQUIDITY_URL, method: "GET" }],
    },
  },
  // Each quantity has paired encodings: all supply encodings must be absent before drift is a dropped datum.
  "zephyr-scanner": {
    ...NUMERIC_CORPUS_FIXTURES["zephyr-scanner"],
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
        reserveAssetAmount: 3_838_581.0555380915,
        reserveAssetPriceUsd: 0.31831006,
        reserveRatioMovingAverage: 3.218013,
        zsdYieldReserve: 315_747.159842202,
        hardForkVersion: 11,
      },
      warnings: [],
      warningsUndefined: true,
      absentMetadata: [],
    },
  },
};
const CORPUS_CASES: Record<string, NumericAdapterCorpusCase> = { ...CAPTURE_CASES, ...NUMERIC_CORPUS_CASES };
// The shared capture inventory is read-only; these replay owners now live here.
const CORPUS_BACKLOG = Object.fromEntries(
  Object.entries(CAPTURE_BACKLOG).filter(([key]) => NUMERIC_CORPUS_CASES[key] === undefined),
);
const caseEntries = Object.entries(CORPUS_CASES) as [LiveReserveAdapterKey, NumericAdapterCorpusCase][];

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
    const declaration = LIVE_RESERVE_ADAPTER_DEFINITIONS[key];
    const allowedFreshnessModes = "validation" in declaration
      ? declaration.validation.allowedFreshnessModes
      : undefined;
    if (allowedFreshnessModes && result.metadata?.freshnessMode) {
      expect(allowedFreshnessModes as readonly string[]).toContain(result.metadata.freshnessMode);
    }
  });

  it.each(caseEntries)("%s surfaces upstream failure or shape drift instead of publishing it", async (key, corpusCase) => {
    // Retryable 5xx drift rows exercise the production 1 s + 2 s backoff. Fake
    // only the timer primitives so the retry policy still runs, then advance it
    // instead of sleeping on the wall clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { drift } = corpusCase;
      const runPromise = runAdapter(key, corpusCase.coin ?? corpusCase.coinId, {
        network: drift.network,
        nowSec: drift.nowSec ?? corpusCase.nowSec,
        validate: false,
      }).then(
        (value) => ({ status: "ok" as const, value }),
        (error: unknown) => ({ status: "error" as const, error }),
      );
      // Let the first attempt settle before advancing, so its per-request
      // timeout is disposed instead of firing during the backoff.
      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTimersAsync();
      const run = await runPromise;

      if (drift.outcome === "error") {
        expect(run.status, `${key}: ${drift.label} published a snapshot instead of failing`).toBe("error");
        if (corpusCase.expected && run.status === "error") {
          expect(run.error).toBeInstanceOf(Error);
          if (drift.error) expect(run.error).toHaveProperty("message", expect.stringMatching(drift.error));
        }
        return;
      }

      if (drift.outcome === "info") {
        expect(run.status, `${key}: ${drift.label} threw; the corpus expects an informational publication`).toBe("ok");
        if (run.status !== "ok") return;
        const warnings = [...(run.value.result.warnings ?? []), ...run.value.report.warnings];
        expect(
          warnings.map((warning) => warning.code),
          `${key}: ${drift.label} published without naming the omitted optional feed`,
        ).toContain(drift.warningCode);
        expect(warnings.find((warning) => warning.code === drift.warningCode)?.effect).toBe("info");
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
    } finally {
      vi.useRealTimers();
    }
  });

  // Optional context sidecars that intentionally publish authoritative on-chain slices with an info warning.
  const G6_FAULT_EXEMPT: Partial<Record<`${LiveReserveAdapterKey}:${G6FaultVector}`, string>> = {
    "superstate-liquidity:data-less-200": "superstate-liquidity-unavailable",
    "superstate-liquidity:numeric-leaf-na": "superstate-liquidity-unavailable",
  };
  const g6FaultRows = buildG6FaultRows(caseEntries);
  const loadG6Clean = createG6CleanBaselineLoader<NumericAdapterCorpusCase>();

  it("exercises non-vacuous G6 fault matrices across corpus HTTP vectors", () => {
    const counts = { "data-less-200": 0, "numeric-leaf-na": 0, "second-response-503": 0 };
    for (const [, fault] of g6FaultRows) counts[fault] += 1;
    expect(counts["data-less-200"]).toBeGreaterThanOrEqual(25);
    expect(counts["numeric-leaf-na"]).toBeGreaterThanOrEqual(25);
    expect(counts["second-response-503"]).toBeGreaterThanOrEqual(6);
  });

  it.each(g6FaultRows)("%s resists G6 fault %s", async (key, fault, corpusCase) => {
    const clean = await loadG6Clean(key, corpusCase);
    const executions = await runG6FaultTargets(key, fault, corpusCase, clean);
    const exemptCode = G6_FAULT_EXEMPT[`${key}:${fault}`];
    expect(executions.length).toBeGreaterThan(0);
    for (const exec of executions) {
      expect(exec.injectedHits, `${key} (${fault} @ ${exec.targetUrl}) fault not injected`).toBeGreaterThan(0);
      if (exemptCode) {
        expect(exec.ok, `${key} (${fault}) exempt adapter must succeed with ${exemptCode}`).toBe(true);
        const warnings = [...(exec.run!.result.warnings ?? []), ...exec.run!.report.warnings];
        expect(warnings.some((w) => w.code === exemptCode && w.effect === "info")).toBe(true);
        expect(exec.run!.result.slices).toEqual(clean.result.slices);
        continue;
      }
      if (!exec.ok) continue;
      const warnings = [...(exec.run!.result.warnings ?? []), ...exec.run!.report.warnings];
      const degraded = !exec.run!.report.valid || warnings.some(
        (w) => (w.effect === "degraded" || w.effect === "fatal") && !clean.degradedCodes.has(w.code),
      );
      expect(degraded, `${key} (${fault} @ ${exec.targetUrl}) published cleanly without degraded warning`).toBe(true);
    }
  });
});
