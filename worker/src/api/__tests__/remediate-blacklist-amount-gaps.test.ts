import { refreshBlacklistAmountRepairQueue } from "../../lib/blacklist/amount-repair-queue";
import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getBlacklistConfigsForSymbolAndChain } from "../../lib/blacklist-contracts";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";

const sqliteFixtures = createLatestSchemaFixtureTracker();

stubCryptoForAuth();

vi.mock("../../lib/blacklist-summary-service", () => ({}));
vi.mock("../../lib/fetch-retry", () => ({ fetchJsonWithRetry: vi.fn() }));

const { handleRemediateBlacklistAmountGapsTrusted } = await import("../remediate-blacklist-amount-gaps");
const destroyConfig = getBlacklistConfigsForSymbolAndChain("USDT", "avalanche")[0]!;
const affectedAddress = "0x1111111111111111111111111111111111111111";
function receiptResponse(amount: number | null) {
  return {
    response: new Response(null, { status: 200 }),
    body: { result: { logs: amount == null ? [] : [{
      address: destroyConfig.contractAddress,
      topics: [destroyConfig.events.find((event) => event.eventType === "destroy")!.topicHash,
        "0x" + affectedAddress.slice(2).padStart(64, "0")],
      data: "0x" + (BigInt(amount) * 1_000_000n).toString(16).padStart(64, "0"),
      blockNumber: "0x64", transactionHash: "0xtx", logIndex: "0x1", timeStamp: "0x65000000",
    }] } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchJsonWithRetry).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  sqliteFixtures.closeAll();
});

describe("handleRemediateBlacklistAmountGaps", () => {
  it.each([
    [10, "resolved"], [null, "resolved"], [10, "suppressed"], [null, "suppressed"],
  ] as const)("rejects stale admin recovery %s after operator %s evidence", async (amount, mutation) => {
    const { db, sqlite } = sqliteFixtures.open();
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, amount_status, amount_source, explorer_tx_url, explorer_address_url)
      VALUES ('admin-race', 'USDT', 'avalanche', 'Avalanche', 'destroy', '${affectedAddress}',
        '0xtx', 100, 1700000000, 'recoverable_pending', 'unavailable', '', '')`).run();
    let resume!: (value: number | null) => void;
    let selected!: () => void;
    const providerStarted = new Promise<void>((resolve) => { selected = resolve; });
    vi.mocked(fetchJsonWithRetry).mockImplementationOnce(async () => {
      selected();
      const value = await new Promise<number | null>((resolve) => { resume = resolve; });
      return receiptResponse(value);
    });
    const pending = handleRemediateBlacklistAmountGapsTrusted({
      db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps?dryRun=false"),
      request: makeApiRequest("/api/remediate-blacklist-amount-gaps", { method: "POST" }),
    });
    await providerStarted;
    if (mutation === "suppressed") {
      sqlite.prepare("UPDATE blacklist_events SET suppression_reason = 'operator-suppressed' WHERE id = 'admin-race'").run();
    } else {
      sqlite.prepare(`UPDATE blacklist_events SET amount_native = 777, amount_usd_at_event = 777,
        amount_status = 'resolved', provenance_source = 'operator-verified',
        provenance_observed_at = 123, amount_attempt_count = 8 WHERE id = 'admin-race'`).run();
    }
    const before = sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'admin-race'").get();
    resume(amount);
    const body = await readJsonResponse(await pending, 200) as {
      applied: { resolved: number; resolvedZero: number; providerFailed: number };
      cacheInvalidation: { attempted: number };
    };
    expect(body.applied).toMatchObject({ resolved: 0, resolvedZero: 0, providerFailed: 0 });
    expect(body.cacheInvalidation.attempted).toBe(0);
    expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'admin-race'").get()).toEqual(before);
  });

  it("repairs unchanged provenance-only rows without requiring a null amount", async () => {
    const { db, sqlite } = sqliteFixtures.open();
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, amount_native, amount_status, explorer_tx_url, explorer_address_url)
      VALUES ('provenance-only', 'USDT', 'avalanche', 'Avalanche', 'destroy', '${affectedAddress}',
        '0xtx', 100, 1700000000, 12, 'provider_failed', '', '')`).run();
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(receiptResponse(25));
    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps?dryRun=false&onlyMissingProvenance=true"),
      request: makeApiRequest("/api/remediate-blacklist-amount-gaps", { method: "POST" }),
    });
    expect((await readJsonResponse(response, 200) as { applied: { resolved: number } }).applied.resolved).toBe(1);
    expect(sqlite.prepare(`SELECT amount_native, amount_status, config_key IS NOT NULL AS has_config,
      contract_address IS NOT NULL AS has_contract FROM blacklist_events WHERE id = 'provenance-only'`).get())
      .toEqual({ amount_native: 25, amount_status: "resolved", has_config: 1, has_contract: 1 });
  });

  it.each([0, 100])("keeps an unproved EURC balance of %s out of event amounts and mirror suppression", async (priorBalance) => {
    const { db, sqlite } = sqliteFixtures.open();
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, amount_status, amount_source, explorer_tx_url, explorer_address_url)
      VALUES ('old-eurc', 'EURC', 'avalanche', 'Avalanche', 'blacklist', '${affectedAddress}',
        '0xtx', 26857200, 1700000000, 'recoverable_pending', 'unavailable', '', '')`).run();
    await refreshBlacklistAmountRepairQueue(db, 1_700_000_000);
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      body: { result: "0x" + (BigInt(priorBalance) * 1_000_000n).toString(16).padStart(64, "0") },
    });
    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps?dryRun=false"),
      request: makeApiRequest("/api/remediate-blacklist-amount-gaps", { method: "POST" }),
    });
    expect((await readJsonResponse(response, 200) as { applied: { resolved: number; providerFailed: number } }).applied)
      .toMatchObject({ resolved: 0, providerFailed: 1 });
    expect(sqlite.prepare(`SELECT amount_native, amount_usd_at_event, amount_status, suppression_reason,
      amount_last_error_class FROM blacklist_events WHERE id = 'old-eurc'`).get()).toEqual({
      amount_native: null, amount_usd_at_event: null, amount_status: "permanently_unavailable",
      suppression_reason: null, amount_last_error_class: "event_time_unproven",
    });
    expect(fetchJsonWithRetry).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT status FROM blacklist_amount_repair_queue WHERE event_id = 'old-eurc'").get())
      .toEqual({ status: "unrecoverable" });
  });

  it.each([true, false])("rejects explicit Tron remediation before reads or writes (dryRun=%s)", async (dryRun) => {
    const db = mockD1([]);
    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db,
      url: makeApiUrl(`/api/remediate-blacklist-amount-gaps?chainId=tron&dryRun=${dryRun}`),
      request: makeApiRequest("/api/remediate-blacklist-amount-gaps", { method: "POST" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Tron event amounts require confirmed transfer replay, not EVM historical-balance remediation",
    });
    expect(db.getHistory()).toEqual([]);
    expect(fetchJsonWithRetry).not.toHaveBeenCalled();
  });

  it.each([true, false])("excludes Tron before the bounded default candidate selection (dryRun=%s)", async (dryRun) => {
    const db = mockD1([
      { match: "FROM blacklist_events", rows: [] },
      { match: "DELETE FROM cache", rows: [] },
    ]);
    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db,
      url: makeApiUrl(`/api/remediate-blacklist-amount-gaps?dryRun=${dryRun}`),
      request: makeApiRequest("/api/remediate-blacklist-amount-gaps", { method: "POST" }),
    });

    expect(response.status).toBe(200);
    const selection = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events"));
    expect(selection?.sql).toContain("chain_id != 'tron'");
    expect(db.getHistory().some((entry) => entry.sql.includes("UPDATE blacklist_events"))).toBe(false);
  });


  it("rejects a write-mode limit that would not fit one atomic batch", async () => {
    // This route is idempotency-wrapped, so a chunked write that failed partway would
    // strand committed rows behind stale caches with no retry path: the wrapper records
    // EXECUTION_UNKNOWN and answers same-key retries from it. The write set must therefore
    // fit a single transaction, and an oversized request is refused before any write.
    const db = makeNoopD1();
    const batchSizes: number[] = [];
    const originalBatch = db.batch.bind(db);
    db.batch = async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    };

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false, limit: D1_BATCH_SIZE + 1 }),
    });
    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db,
      url: makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      request,
    });

    expect(response.status).toBe(400);
    expect(batchSizes).toEqual([]);
  });

  it("still surveys the full window in dry-run mode", async () => {
    const rows = Array.from({ length: D1_BATCH_SIZE + 1 }, (_value, index) => ({
      id: `gap-${index}`,
      stablecoin: "UNKNOWN",
      chain_id: "unknown",
      event_type: "blacklist",
      address: "0xabc",
      tx_hash: `0x${index}`,
      block_number: index,
      timestamp: index,
      amount_status: "recoverable_pending",
      amount_attempt_count: 0,
      amount_last_attempted_at: null,
      contract_address: null,
      config_key: null,
    }));
    const db = mockD1([
      { match: "FROM blacklist_events", rows },
      { match: "UPDATE blacklist_events", rows: [] },
      { match: "DELETE FROM cache", rows: [] },
    ]);
    const batchSizes: number[] = [];
    const originalBatch = db.batch.bind(db);
    db.batch = async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    };

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, limit: D1_BATCH_SIZE + 1 }),
    });
    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db,
      url: makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      request,
    });

    expect(response.status).toBe(200);
    expect(batchSizes).toEqual([]);
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await handleRemediateBlacklistAmountGapsTrusted({ db: makeNoopD1(), url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request: makeApiRequest("/api/remediate-blacklist-amount-gaps", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("rejects non-object JSON bodies", async () => {
    const response = await handleRemediateBlacklistAmountGapsTrusted({ db: makeNoopD1(), url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request: makeApiRequest("/api/remediate-blacklist-amount-gaps", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not-an-object"]),
      }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("returns a dry-run summary for targeted legacy gaps", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "gap-1",
          stablecoin: "USDC",
          chain_id: "avalanche",
          event_type: "blacklist",
          address: "0xabc",
          block_number: 12_757_005,
          timestamp: 1_648_614_948,
          amount_status: "recoverable_pending",
          amount_attempt_count: 0,
          amount_last_attempted_at: null,
          contract_address: null,
          config_key: null,
        }],
      },
    ]);

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: "avalanche", stablecoin: "USDC", dryRun: true }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request });

    const body = await readJsonResponse(response, 200) as {
      dryRun: boolean;
      candidateCount: number;
      resolutionCounts: Record<string, number>;
      sample: Array<{ resolution: string; configKey: string | null }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.candidateCount).toBe(1);
    expect(body.resolutionCounts.resolved).toBe(1);
    expect(body.sample[0]).toMatchObject({
      resolution: "resolved",
      configKey: ["avalanche", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"].join("-"),
    });
  });

  it("includes recoverable amount gaps with existing provenance by default", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "gap-1",
          stablecoin: "XUSD",
          chain_id: "bsc",
          event_type: "blacklist",
          address: "0xabc",
          block_number: 55_583_873,
          timestamp: 1_753_685_880,
          amount_status: "recoverable_pending",
          amount_attempt_count: 0,
          amount_last_attempted_at: null,
          contract_address: "0xf81ac2e1a0373dde1bce01e2fe694a9b7e3bfcb9",
          config_key: ["bsc", "0xf81ac2e1a0373dde1bce01e2fe694a9b7e3bfcb9"].join("-"),
        }],
      },
    ]);

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request });

    const body = await readJsonResponse(response, 200) as {
      filters: { onlyMissingProvenance: boolean };
      candidateCount: number;
      resolutionCounts: Record<string, number>;
    };
    expect(body.filters.onlyMissingProvenance).toBe(false);
    expect(body.candidateCount).toBe(1);
    expect(body.resolutionCounts.resolved).toBe(1);
    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events"));
    expect(selectCall?.sql).not.toContain("contract_address IS NULL OR config_key IS NULL");
  });

  it("keeps provenance-only filtering when explicitly requested", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [],
      },
    ]);

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps?onlyMissingProvenance=true", {
      method: "POST",
      adminKey: "secret-key",
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps?onlyMissingProvenance=true"), request });

    const body = await readJsonResponse(response, 200) as {
      filters: { onlyMissingProvenance: boolean };
      candidateCount: number;
    };
    expect(body.filters.onlyMissingProvenance).toBe(true);
    expect(body.candidateCount).toBe(0);
    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events"));
    expect(selectCall?.sql).toContain("contract_address IS NULL OR config_key IS NULL");
  });

  it("clamps a negative body-supplied maxAttempts to 0 instead of disabling the attempt-count filter", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [],
      },
    ]);

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, maxAttempts: -5 }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request });

    const body = await readJsonResponse(response, 200) as { filters: { maxAttempts: number } };
    expect(body.filters.maxAttempts).toBe(0);
    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events"));
    // maxAttempts clamped to 0 means the COALESCE(amount_attempt_count, 0) <= ? guard is skipped,
    // not a negative bound that would silently match every row.
    expect(selectCall?.sql).not.toContain("COALESCE(amount_attempt_count, 0) <= ?");
  });

  it("updates rows to resolved when a destroy event explicitly emits zero", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(receiptResponse(0));

    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "gap-1",
          stablecoin: "USDT",
          chain_id: "avalanche",
          event_type: "destroy",
          address: affectedAddress,
          block_number: 12_757_005,
          timestamp: 1_648_614_948,
          amount_status: "recoverable_pending",
          amount_attempt_count: 0,
          amount_last_attempted_at: null,
          contract_address: null,
          config_key: null,
        }],
      },
      {
        match: "UPDATE blacklist_events",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [],
        first: null,
      },
      {
        match: "DELETE FROM cache WHERE key = ?",
        rows: [],
        runMeta: { changes: 1 },
      },
    ]);

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: "avalanche", stablecoin: "USDT", dryRun: false }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request });

    const body = await readJsonResponse(response, 200) as {
      applied: {
        resolved: number;
        resolvedZero: number;
        providerFailed: number;
      };
      cacheInvalidation: {
        attempted: number;
        deleted: number;
        failed: number;
      };
    };
    expect(body.applied).toMatchObject({
      resolved: 1,
      resolvedZero: 1,
      providerFailed: 0,
    });
    expect(body.cacheInvalidation).toEqual({
      attempted: 5,
      deleted: 5,
      failed: 0,
    });

    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE blacklist_events"));
    expect(updateCall).toBeTruthy();
    expect(updateCall?.binds[0]).toBe(0);
    expect(updateCall?.binds[1]).toBe(0);
    expect(updateCall?.binds[3]).toBe("resolved");
    const deletedCacheKeys = db.getHistory()
      .filter((entry) => entry.sql.includes("DELETE FROM cache WHERE key = ?"))
      .map((entry) => entry.binds[0])
      .sort();
    expect(deletedCacheKeys).toEqual([
      "blacklist:gap-metrics:producer:v2:86400:core",
      "blacklist:gap-metrics:producer:v2:86400:full",
      "blacklist:gap-metrics:v2:86400:core",
      "blacklist:gap-metrics:v2:86400:full",
      "blacklist:summary:producer:v4",
    ]);
  });

});
