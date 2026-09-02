import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { mockRegistry } from "../../test-helpers/cron";
import { cleanupYieldSourceTest, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "usdc-circle",
      symbol: "USDC",
      contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
      tradedContracts: [],
    },
    {
      id: "eurc-circle",
      symbol: "EURC",
      contracts: [{ chain: "base", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 }],
      tradedContracts: [],
    },
  ];

  return mockRegistry({ stablecoins });
});

vi.mock("../../lib/circuit-breaker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/circuit-breaker")>()),
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeDecision: vi.fn(async () => undefined),
}));

import {
  buildVaultsFyiBudgetPlan,
  fetchVaultsFyiSources,
  finalizeMonthlyCredits,
  readMonthlyCredits,
  reserveMonthlyCredits,
} from "../yield-sync/vaults-fyi";
import type { VaultsFyiRuntimeConfig } from "../../lib/env";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function enabledConfig(
  overrides: Partial<Extract<VaultsFyiRuntimeConfig, { enabled: true }>> = {},
): VaultsFyiRuntimeConfig {
  return {
    enabled: true,
    disabledReason: null,
    apiKey: "test-placeholder-key",
    rankableVaults: [],
    maxCreditsPerRun: null,
    maxCreditsPerMonth: null,
    maxPagesPerRun: null,
    ...overrides,
  };
}

function detailedVault(overrides: Record<string, unknown> = {}) {
  return {
    vaultId: "mainnet-0x1111111111111111111111111111111111111111",
    address: "0x1111111111111111111111111111111111111111",
    name: "Prime USDC Vault",
    network: { name: "mainnet", chainId: 1, networkCaip: "eip155:1" },
    asset: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "SPOOF",
    },
    protocol: { name: "Example", slug: "example" },
    score: { vaultScore: 90 },
    apy: {
      "7day": { base: 0.031, reward: 0.011, total: 0.042 },
    },
    tvl: { usd: "1250000", native: "1250000" },
    lastUpdateTimestamp: "2026-06-12T12:30:00.000Z",
    ...overrides,
  };
}

function creditLedgerDb(initialValue: string | null) {
  let value = initialValue;
  const writes: string[] = [];
  const db = {
    prepare: () => ({
      bind: (...binds: unknown[]) => ({
        first: async () => value == null ? null : { value, updated_at: 1_782_885_600 },
        run: async () => {
          value = String(binds[1]);
          writes.push(value);
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, writes };
}

function sqliteCreditLedgerDb() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("fetchVaultsFyiSources", () => {
  const openDatabases: DatabaseSync[] = [];

  afterEach(() => {
    cleanupYieldSourceTest();
    for (const sqlite of openDatabases.splice(0)) sqlite.close();
  });

  function sqliteLedger() {
    const value = sqliteCreditLedgerDb();
    openDatabases.push(value.sqlite);
    return value;
  }

  it("throttles an unsafe four-hour run cap below the monthly quota", () => {
    const plan = buildVaultsFyiBudgetPlan({
      nowSec: Date.parse("2026-07-01T00:25:00.000Z") / 1000,
      creditsEstimated: 0,
      configuredRunCap: 25,
      monthlyCap: 2_500,
    });

    expect(plan).toMatchObject({
      runsRemaining: 186,
      sustainableRunCap: 13,
      monthlyCreditsForecast: 2_418,
      monthlyUnthrottledForecast: 4_650,
      monthlyBudgetWarning: true,
      coverageBudgetState: "throttled",
    });
    expect(plan.monthlyCreditsForecast).toBeLessThanOrEqual(2_500);
  });

  it("reserves month-to-date credits before fetching and finalizes actual spend", async () => {
    const bucket = "2026-07";
    const { db, writes } = creditLedgerDb(JSON.stringify({
      version: 1,
      bucket,
      creditsEstimated: 100,
    }));
    mockYieldSourceRoutes([{ match: () => true, respond: () => response({ data: [detailedVault()] }) }]);

    const result = await fetchVaultsFyiSources({
      db,
      config: enabledConfig(),
      startSec: Date.parse("2026-07-01T00:25:00.000Z") / 1000,
    });

    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      version: 3,
      bucket,
      generation: 1,
      creditsEstimated: 100,
      creditsReserved: 12,
    });
    expect(JSON.parse(writes[1]!)).toMatchObject({
      version: 3,
      bucket,
      generation: 2,
      creditsEstimated: 104,
      creditsReserved: 0,
      reservationId: null,
    });
    expect(result.telemetry).toMatchObject({
      creditsCap: 12,
      creditsEstimated: 4,
      monthlyCreditsEstimated: 104,
      monthlyCreditsReserved: 0,
      monthlyLedgerState: "valid",
      monthlyBudgetWarning: true,
      coverageBudgetState: "throttled",
    });
  });

  it.each([
    [10_000_000_000, 10_000_000_000],
    [10_000_000_001, 10_000_000],
  ])("keeps the exclusive epoch threshold for %s", async (timestamp, expected) => {
    mockYieldSourceRoutes([{
      match: () => true,
      respond: () => response({ data: detailedVault({ lastUpdateTimestamp: timestamp }) }),
    }]);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({
        rankableVaults: ["mainnet/0x1111111111111111111111111111111111111111"],
      }),
      startSec: 1_781_267_400,
    });

    expect(result.candidates[0]?.yield.sourceObservedAt).toBe(expected);
  });

  it("fails closed without fetching when the paid credit ledger is corrupt", async () => {
    const { db, writes } = creditLedgerDb("{not-json");
    const fetchSpy = mockYieldSourceRoutes([], { requireMatch: true });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchVaultsFyiSources({
      db,
      config: enabledConfig(),
      startSec: Date.parse("2026-07-01T00:25:00.000Z") / 1000,
    });

    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "failed",
        skipReason: "credit-ledger-corrupt",
        monthlyLedgerState: "corrupt",
        coverageBudgetState: "unavailable",
        requestCount: 0,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    logSpy.mockRestore();
  });

  it("distinguishes an absent paid credit ledger from a malformed ledger", async () => {
    const bucket = "2026-07";
    const nowSec = Date.parse("2026-07-01T00:25:00.000Z") / 1000;
    const missing = await readMonthlyCredits(creditLedgerDb(null).db, bucket, nowSec);
    const malformed = await readMonthlyCredits(creditLedgerDb(JSON.stringify({
      version: 3,
      bucket,
      creditsEstimated: -1,
    })).db, bucket, nowSec);
    const overflowing = await readMonthlyCredits(creditLedgerDb(JSON.stringify({
      version: 3,
      bucket,
      generation: 1,
      creditsEstimated: Number.MAX_SAFE_INTEGER,
      creditsReserved: 1,
      reservationId: "expired-owner",
      reservationExpiresAt: nowSec - 1,
    })).db, bucket, nowSec);

    expect(missing).toMatchObject({ state: "missing", creditsEstimated: 0 });
    expect(malformed).toMatchObject({ state: "corrupt", creditsEstimated: 0 });
    expect(overflowing).toMatchObject({ state: "corrupt", creditsEstimated: 0 });
  });

  it("allows only one concurrent reservation owner to win the ledger CAS", async () => {
    const { db } = sqliteLedger();
    const bucket = "2026-07";
    const nowSec = Date.parse("2026-07-01T00:25:00.000Z") / 1000;
    const empty = await readMonthlyCredits(db, bucket, nowSec);
    expect(empty).not.toBeNull();

    const claims = await Promise.all([
      reserveMonthlyCredits(db, bucket, empty!, 12, nowSec),
      reserveMonthlyCredits(db, bucket, empty!, 12, nowSec),
    ]);

    expect(claims.filter((claim) => claim != null)).toHaveLength(1);
    const current = await readMonthlyCredits(db, bucket, nowSec);
    expect(current).toMatchObject({ generation: 1, creditsEstimated: 0, creditsReserved: 12 });
  });

  it("charges an expired owner's reservation and prevents it from overwriting a successor", async () => {
    const { db } = sqliteLedger();
    const bucket = "2026-07";
    const firstAt = Date.parse("2026-07-01T00:25:00.000Z") / 1000;
    const initial = await readMonthlyCredits(db, bucket, firstAt);
    const first = await reserveMonthlyCredits(db, bucket, initial!, 12, firstAt);
    expect(first).not.toBeNull();

    const secondAt = firstAt + 21 * 60;
    const afterExpiry = await readMonthlyCredits(db, bucket, secondAt);
    expect(afterExpiry).toMatchObject({
      generation: 1,
      creditsEstimated: 12,
      creditsReserved: 0,
      reservationId: null,
    });
    const second = await reserveMonthlyCredits(db, bucket, afterExpiry!, 10, secondAt);
    expect(second).not.toBeNull();

    await expect(finalizeMonthlyCredits(db, first, 4)).resolves.toBe(false);
    const current = await readMonthlyCredits(db, bucket, secondAt);
    expect(current).toMatchObject({
      generation: 2,
      creditsEstimated: 12,
      creditsReserved: 10,
      reservationId: second!.reservationId,
    });
  });

  it("keeps month rollover ledgers independent and releases zero-spend reservations", async () => {
    const { db } = sqliteLedger();
    const julyAt = Date.parse("2026-07-31T20:25:00.000Z") / 1000;
    const augustAt = Date.parse("2026-08-01T00:25:00.000Z") / 1000;
    const july = await reserveMonthlyCredits(
      db,
      "2026-07",
      (await readMonthlyCredits(db, "2026-07", julyAt))!,
      5,
      julyAt,
    );
    const august = await reserveMonthlyCredits(
      db,
      "2026-08",
      (await readMonthlyCredits(db, "2026-08", augustAt))!,
      12,
      augustAt,
    );

    expect(july).not.toBeNull();
    expect(august).not.toBeNull();
    await expect(finalizeMonthlyCredits(db, august, 0)).resolves.toBe(true);
    await expect(readMonthlyCredits(db, "2026-07", julyAt)).resolves.toMatchObject({ creditsReserved: 5 });
    await expect(readMonthlyCredits(db, "2026-08", augustAt)).resolves.toMatchObject({
      generation: 2,
      creditsEstimated: 0,
      creditsReserved: 0,
      reservationId: null,
    });
  });

  it("skips without fetching when disabled", async () => {
    const fetchSpy = mockYieldSourceRoutes([], { requireMatch: true });

    await expect(
      fetchVaultsFyiSources({
        config: {
          enabled: false,
          disabledReason: "not-enabled",
          apiKey: null,
          rankableVaults: [],
          maxCreditsPerRun: null,
          maxCreditsPerMonth: null,
          maxPagesPerRun: null,
        },
      }),
    ).resolves.toMatchObject({
      candidates: [],
      telemetry: { status: "skipped", skipReason: "disabled", requestCount: 0 },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces disabled config reasons as skip telemetry", async () => {
    await expect(
      fetchVaultsFyiSources({
        config: {
          enabled: false,
          disabledReason: "no-key",
          apiKey: null,
          rankableVaults: [],
          maxCreditsPerRun: null,
          maxCreditsPerMonth: null,
          maxPagesPerRun: null,
        },
      }),
    ).resolves.toMatchObject({
      candidates: [],
      telemetry: { status: "skipped", skipReason: "no-key", requestCount: 0 },
    });

    await expect(
      fetchVaultsFyiSources({
        config: {
          enabled: false,
          disabledReason: "invalid-enabled-flag",
          apiKey: null,
          rankableVaults: [],
          maxCreditsPerRun: null,
          maxCreditsPerMonth: null,
          maxPagesPerRun: null,
        },
      }),
    ).resolves.toMatchObject({
      candidates: [],
      telemetry: { status: "skipped", skipReason: "invalid-config", requestCount: 0 },
    });
  });

  it("runs a cheap audit-only inventory probe when enabled without rankable vaults", async () => {
    mockYieldSourceRoutes([{ match: () => true, respond: (request) => {
      const url = request.url;
      expect(url).toContain("/v2/detailed-vaults?");
      expect(url).toContain("page=0");
      expect(url).toContain("perPage=4");
      expect(url).not.toContain("test-placeholder-key");
      expect(request.headers.get("x-api-key")).toBe("test-placeholder-key");
      return response({
        data: [detailedVault(), detailedVault({ address: "0x2222222222222222222222222222222222222222" })],
      });
    } }]);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig(),
      startSec: 1_781_267_400,
    });

    expect(result.candidates).toEqual([]);
    expect(result.telemetry).toMatchObject({
      consumptionMode: "probe-only",
      consumptionReason: "rankable-allowlist-empty",
      status: "ok",
      skipReason: null,
      requestCount: 1,
      pageCount: 1,
      pageCapReached: false,
      creditsEstimated: 7,
      creditCapReached: false,
      rawVaultCount: 2,
      auditOnlyCount: 2,
      rankableCandidateCount: 0,
    });
  });

  it("marks bounded audit inventory page caps without treating the provider run as partial", async () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      detailedVault({ address: `0x${String(index + 1).padStart(40, "0")}` }),
    );
    mockYieldSourceRoutes([{ match: () => true, respond: () => response({ data: rows }) }]);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig(),
      startSec: 1_781_267_400,
    });

    expect(result.candidates).toEqual([]);
    expect(result.telemetry).toMatchObject({
      status: "ok",
      skipReason: null,
      requestCount: 1,
      pageCount: 1,
      pageCapReached: true,
      creditCapReached: false,
      creditsEstimated: 13,
      rawVaultCount: 4,
      auditOnlyCount: 4,
    });
  });

  it("emits exact address-matched allowlisted candidates from exact detailed-vault requests and drops symbol-only spoofed assets", async () => {
    const fetchSpy = mockYieldSourceRoutes([{ match: () => true, respond: (request) => {
      const url = request.url;
      expect(url).not.toContain("test-placeholder-key");
      expect(request.headers.get("x-api-key")).toBe("test-placeholder-key");

      if (url.endsWith("/v2/detailed-vaults/mainnet/0x1111111111111111111111111111111111111111")) {
        return response({ data: detailedVault() });
      }
      expect(url).toContain("/v2/detailed-vaults/mainnet/vault-b");
      return response({
        data: detailedVault({
          vaultId: "vault-b",
          address: "0x2222222222222222222222222222222222222222",
          name: "Spoofed USDC Vault",
          asset: {
            address: "0x9999999999999999999999999999999999999999",
            symbol: "USDC",
          },
        }),
      });
    } }]);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({
        maxCreditsPerRun: 100,
        rankableVaults: ["mainnet/0x1111111111111111111111111111111111111111", "mainnet/vault-b"],
      }),
      startSec: 1_781_267_400,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      chain: "ethereum",
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      yield: {
        currentApy: expect.closeTo(4.2, 6),
        apyBase: expect.closeTo(3.1, 6),
        apyReward: expect.closeTo(1.1, 6),
        sourcePool: "mainnet-0x1111111111111111111111111111111111111111",
        sourceTvlUsd: 1_250_000,
        dataSource: "protocol-api",
        sourceKey: "protocol-api:vaults-fyi:ethereum:0x1111111111111111111111111111111111111111",
        yieldSource: "Example: Prime USDC Vault",
        yieldType: "lending-opportunity",
        project: "example",
        sourceObservedAt: 1_781_267_400,
      },
    });
    expect(result.telemetry).toMatchObject({
      status: "ok",
      requestCount: 2,
      pageCount: 0,
      rawVaultCount: 2,
      rankableCandidateCount: 1,
      identityMissCount: 1,
      creditsEstimated: 6,
    });
  });

  it("stops before a detail fetch when the local per-run credit cap is too low", async () => {
    const fetchSpy = mockYieldSourceRoutes([], { requireMatch: true });

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({
        rankableVaults: ["mainnet:vault-a"],
        maxCreditsPerRun: 2,
      }),
      startSec: 1_781_267_400,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "skipped",
        skipReason: "credit-cap",
        requestCount: 0,
        creditCapReached: true,
        creditsEstimated: 0,
      },
    });
  });

  it("does not spend credits when all rankable allowlist entries are malformed", async () => {
    const fetchSpy = mockYieldSourceRoutes([], { requireMatch: true });

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({ rankableVaults: ["not-a-vault-entry"] }),
      startSec: 1_781_267_400,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "skipped",
        skipReason: "invalid-config",
        requestCount: 0,
        creditsEstimated: 0,
      },
    });
  });

  it.each([403, 429])("fails open as skipped on provider quota HTTP %s without emitting candidates", async (status) => {
    mockYieldSourceRoutes([{ match: () => true, respond: () => response({ error: "quota" }, status) }]);

    const result = await fetchVaultsFyiSources({
      config: enabledConfig({ rankableVaults: ["mainnet:vault-a"] }),
      startSec: 1_781_267_400,
    });

    expect(result).toMatchObject({
      candidates: [],
      telemetry: {
        status: "skipped",
        skipReason: "provider-quota",
        requestCount: 1,
        creditsEstimated: 0,
      },
    });
  });
});
