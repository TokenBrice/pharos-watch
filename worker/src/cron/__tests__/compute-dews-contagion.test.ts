import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

// v5.95 contagion amplifier: exercise the real computeDEWS (not mocked) so the
// two-pass scoring loop's amplifier wiring is end-to-end verified.

interface CoinFixture {
  id: string;
  symbol: string;
  pegType: string;
  /** Current supply, USD-denominated per getCirculatingRaw (peggedUSD/peggedEUR bucket). */
  circulating: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  /** Price in USD (real pricing pipeline result). */
  price: number;
  priceConfidence: "high" | "low" | "single-source" | "fallback";
  /** Matches the row mocked into dex_liquidity. */
  weightedBalanceRatio: number;
  avgPoolStress: number;
  liquidityScoreNow: number;
  liquidityScore7dAgo: number;
  tvlNow: number;
  tvl7dAgo: number;
}

// Heavy stress: -20% daily supply + -30% weekly + collapsed pool balance + TVL
// crash + liquidity score drop + price well off peg. Produces score ~91 ->
// DANGER on the first pass.
const HUGE_STRESS: Omit<CoinFixture, "id" | "symbol" | "pegType"> = {
  circulating: 8_000_000_000,
  circulatingPrevDay: 10_000_000_000,
  circulatingPrevWeek: 11_500_000_000,
  price: 0.85,
  priceConfidence: "low",
  weightedBalanceRatio: 0.3,
  avgPoolStress: 90,
  liquidityScoreNow: 40,
  liquidityScore7dAgo: 80,
  tvlNow: 10_000_000,
  tvl7dAgo: 40_000_000,
};

// Minor stress: a single tiny supply contraction, everything else healthy.
// Produces a score well below WARNING so contagion amplification is visible.
const MILD_STRESS: Omit<CoinFixture, "id" | "symbol" | "pegType"> = {
  circulating: 9_900_000_000,
  circulatingPrevDay: 10_000_000_000,
  circulatingPrevWeek: 10_000_000_000,
  price: 1.0,
  priceConfidence: "high",
  weightedBalanceRatio: 0.97,
  avgPoolStress: 3,
  liquidityScoreNow: 80,
  liquidityScore7dAgo: 78,
  tvlNow: 100_000_000,
  tvl7dAgo: 95_000_000,
};

// Pushes score near (but below) the DANGER floor of 76, so contagion * PSI
// amplification would cross 100 without the final clamp in computeDEWS.
const NEAR_MAX_STRESS: Omit<CoinFixture, "id" | "symbol" | "pegType"> = {
  circulating: 8_500_000_000,
  circulatingPrevDay: 10_000_000_000,
  circulatingPrevWeek: 10_300_000_000,
  price: 0.92,
  priceConfidence: "low",
  weightedBalanceRatio: 0.45,
  avgPoolStress: 70,
  liquidityScoreNow: 50,
  liquidityScore7dAgo: 80,
  tvlNow: 20_000_000,
  tvl7dAgo: 50_000_000,
};

function buildFixture(
  id: string,
  symbol: string,
  pegType: string,
  overrides: Omit<CoinFixture, "id" | "symbol" | "pegType">,
): CoinFixture {
  return { id, symbol, pegType, ...overrides };
}

// `var` (not let/const) so the vi.mock factory — hoisted above module-level
// imports — can read the binding during scoring module evaluation without
// hitting a temporal-dead-zone error.
// eslint-disable-next-line no-var
var fixtures: CoinFixture[] = [];
// eslint-disable-next-line no-var
var psiScore: number | null = null;

vi.mock("@shared/lib/psi-eligible", () => ({
  get PSI_ELIGIBLE_STABLECOINS() {
    return (fixtures ?? []).map((fixture) => ({
      id: fixture.id,
      symbol: fixture.symbol,
      flags: { navToken: false },
    }));
  },
  get PSI_ELIGIBLE_META_BY_ID() {
    return new Map(
      (fixtures ?? []).map((fixture) => [
        fixture.id,
        { id: fixture.id, symbol: fixture.symbol, flags: { navToken: false } },
      ]),
    );
  },
}));

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({ rates: { peggedUSD: 1, peggedEUR: 1.08 } })),
  getPegReference: vi.fn((pegType: string) => (pegType === "peggedEUR" ? 1.08 : 1)),
  normalizePegType: vi.fn((pegType: string | undefined) => pegType),
}));

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    batchExecute: vi.fn(async () => {}),
  };
});

// eslint-disable-next-line no-var
var insertedSignals: Record<string, { score: number; band: string; signalsJson: string }> = {};

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async (_db: unknown, key: string) => {
    if (key === "dews:bootstrap-complete") return null;
    return {
      value: JSON.stringify({
        peggedAssets: fixtures.map((fixture) => ({
          id: fixture.id,
          symbol: fixture.symbol,
          pegType: fixture.pegType,
          price: fixture.price,
          priceConfidence: fixture.priceConfidence,
          circulating: { [fixture.pegType]: fixture.circulating },
          circulatingPrevDay: { [fixture.pegType]: fixture.circulatingPrevDay },
          circulatingPrevWeek: { [fixture.pegType]: fixture.circulatingPrevWeek },
        })),
      }),
      updatedAt: Math.floor(Date.now() / 1000),
    } as never;
  }),
  setCache: vi.fn(async () => {}),
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
  writeFreshnessSentinel: vi.fn(async () => {}),
}));

// Real computeDEWS — no mock. Two-pass scoring must propagate amplifiers.
import { computeAndStoreDEWS } from "../compute-dews";

function makeDb(): D1Database {
  const nowSec = Math.floor(Date.now() / 1000);

  const stmt = (sql: string) => {
    let boundArgs: unknown[] = [];
    const all = async <T>() => {
      if (sql.includes("pharos:dews:stress-history-daily-ids")) {
        return { results: fixtures.map((f) => ({ stablecoin_id: f.id })) as T[] };
      }
      if (sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signals")) {
        return { results: fixtures.map((f) => ({ stablecoin_id: f.id })) as T[] };
      }
      if (sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signal_history")) {
        return { results: fixtures.map((f) => ({ stablecoin_id: f.id })) as T[] };
      }
      if (/FROM dex_liquidity(?!_history)/.test(sql)) {
        return {
          results: fixtures.map((f) => ({
            stablecoin_id: f.id,
            weighted_balance_ratio: f.weightedBalanceRatio,
            avg_pool_stress: f.avgPoolStress,
            top_pools_json: "[]",
            liquidity_score: f.liquidityScoreNow,
            total_tvl_usd: f.tvlNow,
            updated_at: nowSec,
          })) as T[],
        };
      }
      if (sql.includes("FROM dex_prices")) {
        return { results: [] as T[] };
      }
      if (sql.includes("FROM stress_signals s")) {
        return { results: [] as T[] };
      }
      if (sql.includes("FROM dex_liquidity_history")) {
        return {
          results: fixtures.map((f) => ({
            stablecoin_id: f.id,
            snapshot_date: nowSec - 7 * 86400,
            liquidity_score: f.liquidityScore7dAgo,
            total_tvl_usd: f.tvl7dAgo,
          })) as T[],
        };
      }
      if (sql.includes("FROM blacklist_events")) return { results: [] as T[] };
      if (sql.includes("FROM yield_data")) return { results: [] as T[] };
      if (sql.includes("FROM mint_burn_hourly")) return { results: [] as T[] };
      return { results: [] as T[] };
    };

    const first = async <T>() => {
      if (sql.includes("pharos:dews:publication-generation-count")) {
        return { cnt: fixtures.length } as T;
      }
      if (sql.includes("pharos:dews:stress-latest-generation-count")) {
        return { cnt: fixtures.length } as T;
      }
      if (sql.includes("stress_signal_history")) return null as T | null;
      if (sql.includes("stability_index_samples")) {
        return psiScore === null
          ? (null as T | null)
          : ({ score: psiScore } as unknown as T);
      }
      return null as T | null;
    };

    const run = async () => ({ success: true, meta: { changes: 1 } });

    return {
      bind: (...args: unknown[]) => {
        boundArgs = args;
        if (sql.includes("pharos:dews:publication-row-insert")) {
          const [stablecoinId, , score, band, signalsJson] = boundArgs as [
            string,
            number,
            number,
            string,
            string,
          ];
          insertedSignals[stablecoinId] = { score, band, signalsJson };
        }
        return { all, first, run };
      },
      all,
      first,
      run,
    };
  };

  return makeNoopD1({
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(
      statements.map((statement) => statement.run()),
    ),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });
}

interface CapturedResult {
  id: string;
  score: number;
  band: string;
  amplifiers: { psi: number; contagion: number };
}

function capturedResults(): Map<string, CapturedResult> {
  const out = new Map<string, CapturedResult>();
  for (const [id, row] of Object.entries(insertedSignals)) {
    const parsed = JSON.parse(row.signalsJson) as {
      signals: Record<string, unknown>;
      amplifiers: { psi: number; contagion: number };
    };
    out.set(id, { id, score: row.score, band: row.band, amplifiers: parsed.amplifiers });
  }
  return out;
}

describe("computeAndStoreDEWS v5.95 contagion amplifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:00:00Z"));
    fixtures = [];
    psiScore = null;
    insertedSignals = {};
  });

  it("applies contagion amplifier to same-peg-type coins when one is DANGER", async () => {
    fixtures = [
      buildFixture("depeg-coin", "DEPEG", "peggedUSD", HUGE_STRESS),
      buildFixture("healthy-coin", "HEAL", "peggedUSD", MILD_STRESS),
    ];

    await computeAndStoreDEWS(makeDb());
    const results = capturedResults();
    const depeg = results.get("depeg-coin")!;
    const healthy = results.get("healthy-coin")!;

    expect(depeg).toBeDefined();
    expect(healthy).toBeDefined();
    expect(depeg.band).toBe("DANGER");
    // Self-exclusion: the triggering coin must not amplify itself.
    expect(depeg.amplifiers.contagion).toBe(1);
    // Healthy USD coin inherits the peg-type amplifier (1.15 for DANGER).
    expect(healthy.amplifiers.contagion).toBeGreaterThan(1);
    expect(healthy.amplifiers.contagion).toBeLessThanOrEqual(1.2);
  });

  it("preserves the first-pass score for the triggering coin itself", async () => {
    // Second pass with self-excluded coin should produce the SAME final result
    // as the first pass: compare a solo-DANGER run (no other coins to compare
    // against) with a two-coin run where DEPEG is DANGER.
    fixtures = [buildFixture("depeg-coin", "DEPEG", "peggedUSD", HUGE_STRESS)];
    await computeAndStoreDEWS(makeDb());
    const soloDepegScore = capturedResults().get("depeg-coin")!.score;

    insertedSignals = {};
    fixtures = [
      buildFixture("depeg-coin", "DEPEG", "peggedUSD", HUGE_STRESS),
      buildFixture("healthy-coin", "HEAL", "peggedUSD", MILD_STRESS),
    ];
    await computeAndStoreDEWS(makeDb());
    const coupledDepegScore = capturedResults().get("depeg-coin")!.score;

    expect(coupledDepegScore).toBe(soloDepegScore);
  });

  it("does not amplify across peg types — an EUR coin is unaffected when a USD coin is DANGER", async () => {
    fixtures = [
      buildFixture("usd-depeg", "USDD", "peggedUSD", HUGE_STRESS),
      buildFixture("eur-healthy", "EURH", "peggedEUR", MILD_STRESS),
    ];

    await computeAndStoreDEWS(makeDb());
    const results = capturedResults();
    const usdDepeg = results.get("usd-depeg")!;
    const eurHealthy = results.get("eur-healthy")!;

    expect(usdDepeg.band).toBe("DANGER");
    expect(eurHealthy.amplifiers.contagion).toBe(1);
  });

  it("final amplifier cap (PSI * contagion) cannot push the score past 100", async () => {
    // Worst case: PSI=0 => 1.3x amplifier, same-peg-type DANGER => 1.15x
    // contagion, total 1.495x. Even with a raw weighted sum near 100, the
    // final score must clamp to <= 100.
    psiScore = 0;
    fixtures = [
      buildFixture("hot-coin", "HOT", "peggedUSD", NEAR_MAX_STRESS),
      buildFixture("anchor-danger", "ANC", "peggedUSD", HUGE_STRESS),
    ];

    await computeAndStoreDEWS(makeDb());
    const hot = capturedResults().get("hot-coin")!;

    expect(hot.score).toBeLessThanOrEqual(100);
    expect(hot.score).toBeGreaterThanOrEqual(0);
  });
});
