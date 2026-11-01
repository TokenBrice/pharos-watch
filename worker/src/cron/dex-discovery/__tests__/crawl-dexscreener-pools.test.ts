import { describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { mockCircuitOutcomeRecord } from "../../../test-helpers/cron";
import {
  crawlDexScreenerPoolsStage,
  createDexScreenerDiscoveryRunState,
  finalizeDexScreenerDiscoveryRun,
  type DexScreenerPoolsStageDependencies,
  type DexScreenerDiscoveryRunState,
} from "../crawl-dexscreener-pools";
import { discoveryContext } from "./discovery.test-support";

const DB = {} as D1Database;

function stageDependencies(
  overrides: Partial<DexScreenerPoolsStageDependencies> = {},
): DexScreenerPoolsStageDependencies {
  return {
    shouldAttemptFetch: vi.fn(async () => true),
    recordOutcome: vi.fn(async () => mockCircuitOutcomeRecord()),
    dsRateLimit: vi.fn(async () => undefined),
    fetchDsTokenPairsWithStatus: vi.fn(async () => ({ ok: true, pairs: [] })),
    ...overrides,
  };
}

function refusedRun(overrides: Partial<DexScreenerDiscoveryRunState> = {}): DexScreenerDiscoveryRunState {
  return {
    ...createDexScreenerDiscoveryRunState(),
    attemptedRequests: 2,
    successfulRequests: 1,
    hardRefusal: { status: 429, contentType: "text/plain", error: "HTTP 429" },
    ...overrides,
  };
}

describe("DexScreener discovery run outcome", () => {
  it("records a failure when a hard refusal follows successful requests", async () => {
    const dependencies = stageDependencies();

    await finalizeDexScreenerDiscoveryRun(DB, refusedRun(), dependencies);

    expect(dependencies.recordOutcome).toHaveBeenCalledTimes(1);
    expect(dependencies.recordOutcome).toHaveBeenCalledWith(
      DB,
      CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY,
      false,
    );
  });

  it("keeps a run without a refusal a success when any request reached the source", async () => {
    const dependencies = stageDependencies();
    const runState = createDexScreenerDiscoveryRunState();
    runState.attemptedRequests = 2;
    runState.successfulRequests = 1;

    await finalizeDexScreenerDiscoveryRun(DB, runState, dependencies);

    expect(dependencies.recordOutcome).toHaveBeenCalledWith(
      DB,
      CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY,
      true,
    );
  });

  it("records nothing when the provider was never attempted", async () => {
    const dependencies = stageDependencies();

    await finalizeDexScreenerDiscoveryRun(DB, createDexScreenerDiscoveryRunState(), dependencies);

    expect(dependencies.recordOutcome).not.toHaveBeenCalled();
  });

  it("stops later targets after a refusal and records the failure immediately", async () => {
    const recordOutcome = vi.fn(async () => mockCircuitOutcomeRecord());
    const fetchDsTokenPairsWithStatus = vi.fn(async () => ({
      ok: false,
      pairs: [],
      status: 429,
      contentType: "text/plain",
      error: "HTTP 429",
      hardRefusal: true,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { value: context } = discoveryContext("test-coin");
    const runState = createDexScreenerDiscoveryRunState();

    const { providerChecks, stoppedEarly } = await crawlDexScreenerPoolsStage({
      db: DB,
      targets: [
        ["ethereum", "0xabc"],
        ["bsc", "0xdef"],
      ],
      context,
      runState,
      dependencies: stageDependencies({ fetchDsTokenPairsWithStatus, recordOutcome }),
    });

    expect(fetchDsTokenPairsWithStatus).toHaveBeenCalledTimes(1);
    expect(stoppedEarly).toBe(false);
    expect(providerChecks).toEqual([
      expect.objectContaining({ provider: "dexscreener", status: "failure", retryable: true }),
    ]);
    expect(recordOutcome).toHaveBeenCalledWith(DB, CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY, false);
    expect(runState).toMatchObject({ outcomeRecorded: true, successfulRequests: 0 });
  });
});
