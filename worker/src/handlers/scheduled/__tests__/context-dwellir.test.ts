import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildChainRpcs,
  hasRegistryRpc,
  supplementalRpcEndpoints,
  type ChainRpcConfig,
} from "../../../lib/chain-registry";
import type { CronResult } from "../../../lib/cron-logger";
import { recordDwellirCredits } from "../../../lib/rpc-provider-budget";
import { type DbCall } from "../../../lib/__tests__/cron-progress.test-support";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "../context";

const ALCHEMY_API_KEY = "alchemy-test-key-placeholder";
const DRPC_API_KEY = "drpc-test-key-placeholder";
const DWELLIR_API_KEY = "dwellir-test-key-placeholder";
const LEDGER_KEY_PREFIX = "rpc:dwellir:credits:v1";
const CIRCUIT_CACHE_KEY = "circuit:dwellir-evm";
const JOB = "sync-stablecoins";

function currentWindow(): string {
  return new Date().toISOString().slice(0, 7);
}

function ledgerCacheKey(): string {
  return `${LEDGER_KEY_PREFIX}:${currentWindow()}`;
}

function ledgerRow(usedCredits: number): string {
  return JSON.stringify({ window: currentWindow(), usedCredits });
}

/** D1 double: records statements, serves seeded cache rows, and can fault cache reads. */
function makeContextDb(
  options: { cacheRows?: Record<string, string>; failCacheReadsFor?: readonly string[] } = {},
) {
  const calls: DbCall[] = [];
  const cacheRows = new Map<string, string>(Object.entries(options.cacheRows ?? {}));
  const failCacheReadsFor = options.failCacheReadsFor ?? [];

  const db = makeNoopD1({
    prepare: (sql: string) => {
      const statement = (args: unknown[] = []): D1PreparedStatement => ({
        bind: (...nextArgs: unknown[]) => statement(nextArgs),
        run: async () => {
          calls.push({ sql, args });
          const [key, value] = args;
          if (sql.includes("INSERT INTO cache") && typeof key === "string" && typeof value === "string") {
            cacheRows.set(key, value);
          }
          return { success: true, meta: { changes: 1 } } as D1Result<unknown>;
        },
        all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
        first: async <T>() => {
          calls.push({ sql, args });
          if (!sql.includes("FROM cache")) return null as T | null;
          const key = String(args[0]);
          if (failCacheReadsFor.some((needle) => key.includes(needle))) {
            throw new Error("cache read unavailable");
          }
          const value = cacheRows.get(key);
          return (value == null ? null : { value, updated_at: Math.floor(Date.now() / 1000) }) as T | null;
        },
      } as unknown as D1PreparedStatement);
      return statement();
    },
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((item) => item.run())),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });

  return {
    db,
    cacheRows,
    cacheReadsFor: (keyPrefix: string) =>
      calls.filter(({ sql, args }) => sql.includes("FROM cache") && String(args[0]).startsWith(keyPrefix)).length,
  };
}

function buildRuntime(options: {
  db: D1Database;
  dwellirApiKey?: string;
  maxCreditsPerMonth?: string;
}): ScheduledRuntimeContext {
  return createScheduledRuntimeContext(
    createWorkerEnv({
      DB: options.db,
      ALCHEMY_API_KEY,
      DRPC_API_KEY,
      ...(options.dwellirApiKey ? { DWELLIR_API_KEY: options.dwellirApiKey } : {}),
      ...(options.maxCreditsPerMonth ? { DWELLIR_MAX_CREDITS_PER_MONTH: options.maxCreditsPerMonth } : {}),
    }),
    {} as ExecutionContext,
    {
      cron: "*/15 * * * *",
      scheduleKey: "quarterHourly",
      scheduledTimeMs: null,
      slotStartedAt: Math.floor(Date.now() / 1000),
    },
  );
}

function dwellirUrls(chainRpcs: Map<string, ChainRpcConfig>): string[] {
  return [...chainRpcs.values()].flatMap((config) =>
    config.endpoints.filter((endpoint) => endpoint.operator === "dwellir").map((endpoint) => endpoint.url),
  );
}

function runJob(
  runtime: ScheduledRuntimeContext,
  fn: () => Promise<CronResult | void> = async () => ({ itemCount: 1 }),
): Promise<CronResult | void> {
  return runtime.runLeasedCron(JOB, async () => fn());
}

describe("scheduled runtime Dwellir enablement", () => {
  const warnings: string[] = [];

  beforeEach(() => {
    warnings.length = 0;
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds chainRpcs registry-only until a job runs", () => {
    const { db } = makeContextDb();
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });
    const registryOnly = buildChainRpcs(ALCHEMY_API_KEY, DRPC_API_KEY);

    expect(dwellirUrls(runtime.chainRpcs)).toEqual([]);
    expect([...runtime.chainRpcs.keys()].sort()).toEqual([...registryOnly.keys()].sort());
    expect(runtime.chainRpcs.get("ethereum")?.endpoints).toEqual(registryOnly.get("ethereum")?.endpoints);
  });

  it("appends Dwellir after every registry operator and adds supplemental-only chains", async () => {
    const { db } = makeContextDb();
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });
    const registryOnly = buildChainRpcs(ALCHEMY_API_KEY, DRPC_API_KEY);

    await runJob(runtime);

    for (const [chainId, registryConfig] of registryOnly) {
      const endpoints = runtime.chainRpcs.get(chainId)?.endpoints ?? [];
      const dwellir = endpoints.filter((endpoint) => endpoint.operator === "dwellir");
      expect(dwellir.length).toBeLessThanOrEqual(1);
      expect(endpoints.slice(0, endpoints.length - dwellir.length)).toEqual(registryConfig.endpoints);
    }

    const ethereumEndpoints = runtime.chainRpcs.get("ethereum")?.endpoints ?? [];
    expect(ethereumEndpoints[ethereumEndpoints.length - 1]).toMatchObject({
      url: "https://api-ethereum-mainnet-erigon.n.dwellir.com",
      operator: "dwellir",
      keyed: true,
      position: "supplemental",
      stateHistory: "archive",
    });

    // A chain that only has coin pins gains a supplemental-only config, which
    // must not read as RPC-readable.
    expect(registryOnly.has("megaeth")).toBe(false);
    const megaeth = runtime.chainRpcs.get("megaeth");
    expect(hasRegistryRpc(megaeth)).toBe(false);
    expect(supplementalRpcEndpoints(megaeth).map((endpoint) => endpoint.operator)).toEqual(["dwellir"]);
  });

  it("withholds Dwellir and never reads the ledger without a key", async () => {
    const { db, cacheReadsFor } = makeContextDb();
    const runtime = buildRuntime({ db });
    const registryOnly = buildChainRpcs(ALCHEMY_API_KEY, DRPC_API_KEY);

    await runJob(runtime);

    expect(dwellirUrls(runtime.chainRpcs)).toEqual([]);
    expect([...runtime.chainRpcs.keys()].sort()).toEqual([...registryOnly.keys()].sort());
    expect(cacheReadsFor(LEDGER_KEY_PREFIX)).toBe(0);
    expect(cacheReadsFor(CIRCUIT_CACHE_KEY)).toBe(0);
  });

  it("withholds Dwellir once the monthly credit budget is exhausted", async () => {
    const { db, cacheReadsFor } = makeContextDb({
      cacheRows: { [ledgerCacheKey()]: ledgerRow(1_000) },
    });
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY, maxCreditsPerMonth: "1000" });

    await runJob(runtime);

    expect(dwellirUrls(runtime.chainRpcs)).toEqual([]);
    expect(cacheReadsFor(LEDGER_KEY_PREFIX)).toBe(1);
    // The circuit is never probed when the budget already forbids Dwellir.
    expect(cacheReadsFor(CIRCUIT_CACHE_KEY)).toBe(0);
  });

  it("withholds Dwellir when the credit ledger cannot be read", async () => {
    const { db } = makeContextDb({ cacheRows: { [ledgerCacheKey()]: "not-json" } });
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    await runJob(runtime);

    expect(dwellirUrls(runtime.chainRpcs)).toEqual([]);
  });

  it("withholds Dwellir while the circuit is open, across jobs and without re-reading", async () => {
    const openedAtSec = Math.floor(Date.now() / 1000);
    const { db, cacheReadsFor } = makeContextDb({
      cacheRows: {
        [ledgerCacheKey()]: ledgerRow(0),
        [CIRCUIT_CACHE_KEY]: JSON.stringify({
          state: "open",
          consecutiveFailures: 3,
          lastFailureAt: openedAtSec,
          lastSuccessAt: null,
          openedAt: openedAtSec,
        }),
      },
    });
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    await runJob(runtime);
    await runJob(runtime);

    expect(dwellirUrls(runtime.chainRpcs)).toEqual([]);
    expect(cacheReadsFor(LEDGER_KEY_PREFIX)).toBe(1);
    expect(cacheReadsFor(CIRCUIT_CACHE_KEY)).toBe(1);
  });

  it("reads the budget and circuit once per runtime across jobs", async () => {
    const { db, cacheReadsFor } = makeContextDb({ cacheRows: { [ledgerCacheKey()]: ledgerRow(0) } });
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    await runJob(runtime);
    await runJob(runtime);

    expect(dwellirUrls(runtime.chainRpcs).length).toBeGreaterThan(0);
    expect(cacheReadsFor(LEDGER_KEY_PREFIX)).toBe(1);
    expect(cacheReadsFor(CIRCUIT_CACHE_KEY)).toBe(1);
  });

  it("reads the budget once for concurrently started jobs", async () => {
    const { db, cacheReadsFor } = makeContextDb({ cacheRows: { [ledgerCacheKey()]: ledgerRow(0) } });
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    await Promise.all([runJob(runtime), runJob(runtime)]);

    expect(dwellirUrls(runtime.chainRpcs).length).toBeGreaterThan(0);
    expect(cacheReadsFor(LEDGER_KEY_PREFIX)).toBe(1);
  });

  it("fails closed, logs once, and keeps the job running when enablement errors", async () => {
    const { db } = makeContextDb({
      cacheRows: { [ledgerCacheKey()]: ledgerRow(0) },
      failCacheReadsFor: [CIRCUIT_CACHE_KEY],
    });
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    const first = await runJob(runtime, async () => ({ itemCount: 5 }));
    const second = await runJob(runtime, async () => ({ itemCount: 6 }));

    expect(first).toMatchObject({ itemCount: 5 });
    expect(second).toMatchObject({ itemCount: 6 });
    expect(dwellirUrls(runtime.chainRpcs)).toEqual([]);
    expect(warnings.filter((line) => line.includes("dwellir_runtime_enablement_failed"))).toHaveLength(1);
  });

  it("flushes credits accrued by a successful job body into the monthly ledger", async () => {
    const { db, cacheRows } = makeContextDb();
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    const result = await runJob(runtime, async () => {
      recordDwellirCredits(3);
      return { itemCount: 7 };
    });

    expect(result).toMatchObject({ itemCount: 7 });
    expect(JSON.parse(String(cacheRows.get(ledgerCacheKey())))).toEqual({
      window: currentWindow(),
      usedCredits: 3,
    });
  });

  it("flushes credits accrued by a throwing job body and preserves the failure", async () => {
    const { db, cacheRows } = makeContextDb();
    const runtime = buildRuntime({ db, dwellirApiKey: DWELLIR_API_KEY });

    await expect(
      runJob(runtime, async () => {
        recordDwellirCredits(2);
        throw new Error("job body failed");
      }),
    ).rejects.toThrow("job body failed");

    expect(JSON.parse(String(cacheRows.get(ledgerCacheKey())))).toEqual({
      window: currentWindow(),
      usedCredits: 2,
    });
  });
});
