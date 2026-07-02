import { describe, expect, it } from "vitest";
import { loadDewsSourceState } from "../source-state";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";

/**
 * Minimal D1 mock that returns a single row from the previous-stress-signals
 * SELECT and empty results elsewhere. Used to verify that legacy flat-shape
 * `signals_json` blobs (no `amplifiers` wrapper) hydrate cleanly alongside
 * the new `{ signals, amplifiers }` shape.
 */
function mockDbWithPrevRows(
  prevRows: Array<{
    stablecoin_id: string;
    signals_json: string;
    band: string;
    computed_at: number;
  }>,
  rankingsCache?: { value: string; updated_at: number },
  blacklistRows: Array<{
    stablecoin: string;
    chain_id: string;
    config_key: string | null;
    contract_address: string | null;
    timestamp: number;
  }> = [],
  latestRows: Array<{
    stablecoin_id: string;
    signals_json: string;
    band: string;
    computed_at: number;
  }> = [],
  publishedGeneration: number | null = null,
): D1Database {
  const pointerRow = publishedGeneration == null
    ? null
    : {
        value: JSON.stringify({
          updatedAt: publishedGeneration,
          source: "compute-dews",
          publishStatus: "published",
        }),
        updated_at: publishedGeneration,
      };
  const filterByCutoff = <T extends { computed_at: number }>(rows: T[], binds: unknown[]): T[] => {
    const cutoff = typeof binds[0] === "number" ? binds[0] : null;
    return cutoff == null ? rows : rows.filter((row) => row.computed_at <= cutoff);
  };
  const stmt = (sql: string, binds: unknown[] = []) => {
    const all = async <T>() => {
      if (sql.includes("FROM stress_signals_latest")) {
        return { results: filterByCutoff(latestRows, binds) as unknown as T[] };
      }
      if (sql.includes("FROM stress_signals s")) {
        return { results: filterByCutoff(prevRows, binds) as unknown as T[] };
      }
      if (sql.includes("FROM blacklist_events")) {
        return { results: blacklistRows as unknown as T[] };
      }
      return { results: [] as T[] };
    };
    const first = async <T>() => {
      if (sql.includes("FROM cache WHERE key = ?")) {
        if (binds[0] === "dews:published-generation") return pointerRow as T | null;
        if (binds[0] === "yield-rankings") return (rankingsCache ?? null) as T | null;
        return null as T | null;
      }
      return null as T | null;
    };
    const run = async () => ({ success: true, meta: { changes: 0 } });
    return {
      bind: (...args: unknown[]) => stmt(sql, args),
      all,
      first,
      run,
    };
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("loadDewsSourceState legacy signals_json hydration", () => {
  const nowSec = 1_700_000_000;

  it("hydrates a legacy flat-shape signals_json row (no amplifiers wrapper)", async () => {
    const legacyPayload = {
      supply: { value: 5, available: true },
      pool: { value: 12, available: true },
    };
    const db = mockDbWithPrevRows([
      {
        stablecoin_id: "usdt-tether",
        signals_json: JSON.stringify(legacyPayload),
        band: "CALM",
        computed_at: nowSec - 600,
      },
    ]);

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    // Legacy rows surface as the flat signals map (no `.signals` wrapper key).
    const prev = sourceState.prevSignals.get("usdt-tether");
    expect(prev).toBeDefined();
    expect(prev?.signals.supply).toEqual({ value: 5, available: true });
    expect(prev?.signals.pool).toEqual({ value: 12, available: true });
    expect(prev?.ageSec).toBe(600);
  });

  it("hydrates a new wrapped-shape signals_json row by unwrapping .signals", async () => {
    const newPayload = {
      signals: {
        supply: { value: 8, available: true },
      },
      amplifiers: { psi: 1, contagion: 1 },
    };
    const db = mockDbWithPrevRows([
      {
        stablecoin_id: "usdt-tether",
        signals_json: JSON.stringify(newPayload),
        band: "CALM",
        computed_at: nowSec - 600,
      },
    ]);

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    // New rows surface as the unwrapped signals map for back-compat with the
    // existing smoothing read path.
    const prev = sourceState.prevSignals.get("usdt-tether");
    expect(prev).toBeDefined();
    expect(prev?.signals.supply).toEqual({ value: 8, available: true });
    // The amplifiers envelope is stripped — downstream hydration defaults it
    // to { psi: 1, contagion: 1 } when re-scoring.
    expect((prev?.signals as Record<string, unknown>).amplifiers).toBeUndefined();
  });

  it("prefers newer latest-table rows while keeping legacy-only rows", async () => {
    const latestPayload = { signals: { supply: { value: 8, available: true } } };
    const legacyPayload = { signals: { supply: { value: 3, available: true } } };
    const db = mockDbWithPrevRows(
      [
        {
          stablecoin_id: "usdt-tether",
          signals_json: JSON.stringify(legacyPayload),
          band: "CALM",
          computed_at: nowSec - 900,
        },
        {
          stablecoin_id: "usdc-circle",
          signals_json: JSON.stringify(legacyPayload),
          band: "CALM",
          computed_at: nowSec - 700,
        },
      ],
      undefined,
      [],
      [
        {
          stablecoin_id: "usdt-tether",
          signals_json: JSON.stringify(latestPayload),
          band: "WARNING",
          computed_at: nowSec - 300,
        },
      ],
    );

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    expect(sourceState.prevSignals.get("usdt-tether")?.signals.supply).toEqual({ value: 8, available: true });
    expect(sourceState.prevSignals.get("usdc-circle")?.signals.supply).toEqual({ value: 3, available: true });
  });

  it("ignores previous stress rows newer than the published DEWS generation", async () => {
    const publishedAt = nowSec - 600;
    const latestPayload = { signals: { supply: { value: 8, available: true } } };
    const legacyPayload = { signals: { supply: { value: 3, available: true } } };
    const db = mockDbWithPrevRows(
      [
        {
          stablecoin_id: "usdt-tether",
          signals_json: JSON.stringify(legacyPayload),
          band: "CALM",
          computed_at: publishedAt,
        },
      ],
      undefined,
      [],
      [
        {
          stablecoin_id: "usdt-tether",
          signals_json: JSON.stringify(latestPayload),
          band: "WARNING",
          computed_at: publishedAt + 300,
        },
      ],
      publishedAt,
    );

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    expect(sourceState.prevSignals.get("usdt-tether")?.signals.supply).toEqual({ value: 3, available: true });
  });

  it("hydrates structured yield source-risk and rank attribution from rankings cache", async () => {
    const db = mockDbWithPrevRows([], {
      value: JSON.stringify({
        rankings: [
          {
            id: "usdt-tether",
            sourceRisk: {
              sourceRiskPenalty: 1.5,
              rewardShare: 0.9,
              sourceAgeSeconds: 30_000,
              venueRiskTier: "unknown",
            },
            rankChangeAttribution: {
              rankDelta: -5,
              primaryDriver: "source-risk",
            },
          },
        ],
      }),
      updated_at: nowSec,
    });

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    expect(sourceState.yieldSourceRisk.get("usdt-tether")).toMatchObject({
      sourceRiskPenalty: 1.5,
      rewardShare: 0.9,
      sourceAgeSeconds: 30_000,
      venueRiskTier: "unknown",
    });
    expect(sourceState.yieldRankChangeAttribution.get("usdt-tether")).toMatchObject({
      rankDelta: -5,
      primaryDriver: "source-risk",
    });
    expect(sourceState.sourceCoverage.yieldStructuredRows).toBe(1);
  });

  it("hydrates blacklist counts by tracker stablecoin id instead of bare symbol", async () => {
    const config = CONTRACT_CONFIGS.find((entry) => entry.stablecoinId === "usda-avalon");
    expect(config).toBeDefined();

    const db = mockDbWithPrevRows([], undefined, [
      {
        stablecoin: "USDA",
        chain_id: config!.chain.chainId,
        config_key: config!.configKey,
        contract_address: config!.contractAddress,
        timestamp: nowSec - 300,
      },
    ]);

    const sourceState = await loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    });

    expect(sourceState.blacklistCounts.get("usda-avalon")).toEqual({ count24h: 1, count7d: 1 });
    expect(sourceState.blacklistCounts.has("USDA")).toBe(false);
    expect(sourceState.blacklistCounts.has("usda-anzens")).toBe(false);
  });

  it("starts independent D1 source hydrators without waiting for the first query to finish", async () => {
    type PendingCall = {
      label: string;
      kind: "all" | "first";
      resolve: (value: unknown) => void;
    };
    const pending: PendingCall[] = [];
    const started: string[] = [];

    const labelSql = (sql: string, binds: unknown[]): string => {
      if (sql.includes("FROM dex_liquidity_history")) return "dex-liquidity-history";
      if (/FROM\s+dex_liquidity\b/.test(sql)) return "dex-liquidity";
      if (sql.includes("FROM dex_liquidity_publication_generations")) {
        return sql.includes("WHERE state = 'published'")
          ? "dex-liquidity-publication:latest-published"
          : "dex-liquidity-publication:latest";
      }
      if (sql.includes("FROM dex_prices")) return "dex-prices";
      if (sql.includes("FROM blacklist_events")) return "blacklist-events";
      if (sql.includes("COUNT(DISTINCT date")) return "mint-burn-30d";
      if (sql.includes("FROM mint_burn_hourly")) return "mint-burn-24h";
      if (sql.includes("FROM yield_data")) return "yield-warnings";
      if (sql.includes("FROM cache WHERE key = ?")) return `cache:${String(binds[0])}`;
      if (sql.includes("FROM stability_index_samples")) return "latest-psi-score";
      if (sql.includes("FROM stress_signals_latest")) return "previous-stress-latest";
      if (sql.includes("FROM stress_signals s")) return "previous-stress-legacy";
      return sql.replace(/\s+/g, " ").trim();
    };

    const resultFor = (call: PendingCall): unknown => {
      if (call.kind === "first") return null;
      return { results: [] };
    };

    const stmt = (sql: string, binds: unknown[] = []) => {
      const enqueue = (kind: "all" | "first") => new Promise<unknown>((resolve) => {
        const label = labelSql(sql, binds);
        started.push(label);
        pending.push({ label, kind, resolve });
      });
      return {
        bind: (...args: unknown[]) => stmt(sql, args),
        all: async <T>() => (await enqueue("all")) as { results: T[] },
        first: async <T>() => (await enqueue("first")) as T | null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
      };
    };

    const db = {
      prepare: (sql: string) => stmt(sql),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    let settled = false;
    const loadPromise = loadDewsSourceState({
      db,
      nowSec,
      bootstrapPending: false,
      registerSourceFailure: () => {},
      registerMalformedPersistedInput: () => {},
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(started).toEqual(expect.arrayContaining([
      "dex-liquidity",
      "dex-prices",
      "dex-liquidity-history",
      "blacklist-events",
      "cache:dews:published-generation",
      "mint-burn-24h",
      "yield-warnings",
      "cache:yield-rankings",
      "latest-psi-score",
    ]));

    for (let guard = 0; !settled && guard < 10; guard++) {
      const batch = pending.splice(0);
      for (const call of batch) {
        call.resolve(resultFor(call));
      }
      await Promise.resolve();
    }

    await loadPromise;
  });
});
