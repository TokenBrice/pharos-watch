import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import fixture from "./fixtures/susd-solayer-mint-slot-450811104.json";

const fetchJsonWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: (...args: unknown[]) => fetchJsonWithRetryMock(...args),
}));

import {
  computeToken2022InterestBearingExchangeRate,
  fetchSusdSolayerNavPrice,
  parseSusdSolayerMintState,
  susdSolayerNavProvider,
} from "../authoritative-price-sources/susd-solayer";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";
import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import { validatePrimaryPriceCandidate } from "../price-publish-policy";
import { buildPriceValidationContext } from "../price-validation";

// Fixture capture instant: block time of Solana slot 450811104.
const NOW = new Date("2026-09-26T22:38:14.000Z");
const BLOCK_TIME_SEC = 1790462294;
// SPL token-2022 exchange rate (with on-chain whole-bps average rounding) at
// the fixture block, derived from the captured mint state.
const EXPECTED_EXCHANGE_RATE = 1.1555804623631452;

function ok(body: unknown): { response: Response; body: unknown } {
  return { response: new Response(null, { status: 200 }), body };
}

function installFixtureResponses(overrides: { account?: unknown; blockTime?: unknown } = {}): void {
  fetchJsonWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "getAccountInfo") {
      return ok({ result: overrides.account ?? structuredClone(fixture.account.result) });
    }
    if (body.method === "getBlockTime") {
      return ok({ result: (overrides.blockTime as number | undefined) ?? fixture.blockTime.result });
    }
    throw new Error(`unexpected Solana RPC call: ${body.method} at ${url}`);
  });
}

describe("Solayer sUSD Token-2022 NAV", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchJsonWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replicates the SPL interest-bearing exchange rate from the captured mint state", () => {
    const state = parseSusdSolayerMintState(fixture.account.result);
    expect(state).toEqual({
      slot: fixture.account.result.context.slot,
      interest: {
        currentRateBps: 3091,
        initializationTimestampSec: 1727476198,
        lastUpdateTimestampSec: 1789420162,
        preUpdateAverageRateBps: 684,
      },
    });
    expect(computeToken2022InterestBearingExchangeRate(state!.interest, BLOCK_TIME_SEC)).toBeCloseTo(
      EXPECTED_EXCHANGE_RATE,
      10,
    );
  });

  it("rejects accrual inputs that the on-chain formula cannot evaluate", () => {
    const interest = {
      currentRateBps: 3091,
      initializationTimestampSec: 1727476198,
      lastUpdateTimestampSec: 1789420162,
      preUpdateAverageRateBps: 684,
    };
    expect(computeToken2022InterestBearingExchangeRate(interest, interest.lastUpdateTimestampSec - 1)).toBeNull();
    expect(
      computeToken2022InterestBearingExchangeRate(
        { ...interest, lastUpdateTimestampSec: interest.initializationTimestampSec - 1 },
        BLOCK_TIME_SEC,
      ),
    ).toBeNull();
    expect(computeToken2022InterestBearingExchangeRate({ ...interest, currentRateBps: 3091.5 }, BLOCK_TIME_SEC)).toBeNull();
    expect(computeToken2022InterestBearingExchangeRate({ ...interest, preUpdateAverageRateBps: -1 }, BLOCK_TIME_SEC)).toBeNull();
  });
  it("fails closed for a non-Token-2022 owner, wrong decimals, or a missing interest config", () => {
    const base = fixture.account.result;
    expect(parseSusdSolayerMintState({ ...base, value: { ...base.value, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } })).toBeNull();
    const decimalsPatch = structuredClone(base);
    decimalsPatch.value.data.parsed.info.decimals = 9;
    expect(parseSusdSolayerMintState(decimalsPatch)).toBeNull();
    const noInterest = structuredClone(base);
    noInterest.value.data.parsed.info.extensions = noInterest.value.data.parsed.info.extensions.filter(
      (entry: { extension: string }) => entry.extension !== "interestBearingConfig",
    );
    expect(parseSusdSolayerMintState(noInterest)).toBeNull();
  });

  it("returns a high-confidence protocol-redeem override pinned to the observed block time", async () => {
    installFixtureResponses();
    const context: LivePriceContext = { assetsById: new Map() };
    await expect(fetchSusdSolayerNavPrice(context)).resolves.toEqual({
      price: EXPECTED_EXCHANGE_RATE,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: BLOCK_TIME_SEC,
      observedAtMode: "upstream",
    });

    const calls = fetchJsonWithRetryMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: JSON.parse(String((init as RequestInit).body)).method,
    }));
    expect(calls[0]).toMatchObject({ url: "https://api.mainnet-beta.solana.com", method: "getAccountInfo" });
    expect(calls[1]).toMatchObject({ url: "https://api.mainnet-beta.solana.com", method: "getBlockTime" });
    for (const [, , retries, options] of fetchJsonWithRetryMock.mock.calls) {
      expect(retries).toBe(0);
      expect(options).toMatchObject({ timeoutMs: 2_500 });
    }
  });

  it("fails closed when the observed block or the rate update is not fresh", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const staleContext = (): LivePriceContext => ({ assetsById: new Map() });
    let context = staleContext();
    installFixtureResponses();
    vi.setSystemTime(new Date("2026-09-26T22:50:00.000Z"));
    await expect(fetchSusdSolayerNavPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("susd-nav:stale-block");

    context = staleContext();
    vi.setSystemTime(NOW);
    installFixtureResponses({ blockTime: fixture.blockTime.result + 3_600 });
    await expect(fetchSusdSolayerNavPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("susd-nav:future-block");

    context = staleContext();
    const futureRateUpdate = structuredClone(fixture.account.result);
    const futureRateInterest = futureRateUpdate.value.data.parsed.info.extensions.find(
      (entry: { extension: string }) => entry.extension === "interestBearingConfig",
    )!;
    futureRateInterest.state.lastUpdateTimestamp = BLOCK_TIME_SEC + 3_600;
    installFixtureResponses({ account: futureRateUpdate });
    await expect(fetchSusdSolayerNavPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("susd-nav:rate-timestamp");
  });

  it("fails closed when the accrued exchange rate leaves the NAV band", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runaway = structuredClone(fixture.account.result);
    const interest = runaway.value.data.parsed.info.extensions.find(
      (entry: { extension: string }) => entry.extension === "interestBearingConfig",
    )!;
    // 32768 bps sustained since initialization compounds far past the 10x NAV cap.
    interest.state.currentRate = 32_768;
    interest.state.preUpdateAverageRate = 32_768;
    interest.state.lastUpdateTimestamp = 1727476198;
    installFixtureResponses({ account: runaway });

    const context: LivePriceContext = { assetsById: new Map() };
    await expect(fetchSusdSolayerNavPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("susd-nav:rate-band");
  });

  it("is wired into the authoritative provider registry for susd-solayer", async () => {
    installFixtureResponses();

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "susd-solayer",
        name: "Solayer USD",
        symbol: "sUSD",
        price: null,
      } as PeggedAsset,
    ]);

    expect(overrides.get("susd-solayer")).toMatchObject({
      price: EXPECTED_EXCHANGE_RATE,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: BLOCK_TIME_SEC,
    });
    expect(susdSolayerNavProvider.matches("susd-solayer")).toBe(true);
    expect(susdSolayerNavProvider.matches("susd-synthetix")).toBe(false);
  });

  it("admits the accrued NAV through normal fixed-peg publication policy", () => {
    expect(
      validatePrimaryPriceCandidate({
        price: EXPECTED_EXCHANGE_RATE,
        source: "protocol-redeem",
        confidence: "high",
        agreeSources: ["protocol-redeem"],
        validationContext: buildPriceValidationContext({
          stablecoinId: "susd-solayer",
          pegType: "peggedUSD",
        }),
      }),
    ).toMatchObject({ accepted: true });
  });
});
