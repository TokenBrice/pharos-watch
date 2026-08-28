import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { D1_BATCH_SIZE } from "../../lib/constants";

stubCryptoForAuth();

vi.mock("../../lib/blacklist-summary-service", () => ({}));
vi.mock("../../lib/blacklist/balance-providers", () => ({
  fetchEvmTokenBalance: vi.fn(),
}));

const { handleRemediateBlacklistAmountGapsTrusted } = await import("../remediate-blacklist-amount-gaps");
const { fetchEvmTokenBalance } = await import("../../lib/blacklist/balance-providers");

const testChainRpcs = new Map<string, ChainRpcConfig>([
  ["avalanche", {
    chainId: "avalanche",
    chainName: "Avalanche",
    type: "evm",
    rpcUrl: "https://avalanche-rpc.example",
    explorerUrl: "https://snowtrace.io",
  }],
]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleRemediateBlacklistAmountGaps", () => {

  it("rejects a write-mode limit that would not fit one atomic batch", async () => {
    // This route is idempotency-wrapped, so a chunked write that failed partway would
    // strand committed rows behind stale caches with no retry path: the wrapper records
    // EXECUTION_UNKNOWN and answers same-key retries from it. The write set must therefore
    // fit a single transaction, and an oversized request is refused before any write.
    const db = mockD1([], { allowUnmatched: true });
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
      chainRpcs: testChainRpcs,
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
    const db = mockD1([{ match: "FROM blacklist_events", rows }], { allowUnmatched: true });
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
      chainRpcs: testChainRpcs,
    });

    expect(response.status).toBe(200);
    expect(batchSizes).toEqual([]);
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await handleRemediateBlacklistAmountGapsTrusted({ db: mockD1([], { allowUnmatched: true }), url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request: makeApiRequest("/api/remediate-blacklist-amount-gaps", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }), chainRpcs: testChainRpcs });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("rejects non-object JSON bodies", async () => {
    const response = await handleRemediateBlacklistAmountGapsTrusted({ db: mockD1([], { allowUnmatched: true }), url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request: makeApiRequest("/api/remediate-blacklist-amount-gaps", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not-an-object"]),
      }), chainRpcs: testChainRpcs });

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
    ], { requireMatch: true });

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: "avalanche", stablecoin: "USDC", dryRun: true }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request, chainRpcs: testChainRpcs });

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
    ], { requireMatch: true });

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request, chainRpcs: testChainRpcs });

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
    ], { requireMatch: true });

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps?onlyMissingProvenance=true", {
      method: "POST",
      adminKey: "secret-key",
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps?onlyMissingProvenance=true"), request, chainRpcs: testChainRpcs });

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
    ], { requireMatch: true });

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, maxAttempts: -5 }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request, chainRpcs: testChainRpcs });

    const body = await readJsonResponse(response, 200) as { filters: { maxAttempts: number } };
    expect(body.filters.maxAttempts).toBe(0);
    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events"));
    // maxAttempts clamped to 0 means the COALESCE(amount_attempt_count, 0) <= ? guard is skipped,
    // not a negative bound that would silently match every row.
    expect(selectCall?.sql).not.toContain("COALESCE(amount_attempt_count, 0) <= ?");
  });

  it("updates rows to resolved when historical balance recovery returns zero", async () => {
    vi.mocked(fetchEvmTokenBalance).mockResolvedValue(0);

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
    ], { requireMatch: true });

    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: "avalanche", stablecoin: "USDC", dryRun: false }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl("/api/remediate-blacklist-amount-gaps"), request, chainRpcs: testChainRpcs });

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
    expect(updateCall?.binds[4]).toBe("resolved");
    const deletedCacheKeys = db.getHistory()
      .filter((entry) => entry.sql.includes("DELETE FROM cache WHERE key = ?"))
      .map((entry) => entry.binds[0])
      .sort();
    expect(deletedCacheKeys).toEqual([
      "blacklist:gap-metrics:producer:v1:86400:core",
      "blacklist:gap-metrics:producer:v1:86400:full",
      "blacklist:gap-metrics:v1:86400:core",
      "blacklist:gap-metrics:v1:86400:full",
      "blacklist:summary:producer:v1",
    ]);
  });

  it("cannot persist a Circle EURC mirror zero as resolved during admin remediation", async () => {
    vi.mocked(fetchEvmTokenBalance).mockResolvedValue(0);

    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "eurc-mirror-gap",
          stablecoin: "EURC",
          chain_id: "avalanche",
          event_type: "blacklist",
          address: "0xabc",
          tx_hash: "0xmirror",
          block_number: 26_857_200,
          timestamp: 1_700_000_000,
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
    ], { requireMatch: true });
    const request = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret-key",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: "avalanche", stablecoin: "EURC", dryRun: false }),
    });

    const response = await handleRemediateBlacklistAmountGapsTrusted({
      db,
      url: makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      request,
      chainRpcs: testChainRpcs,
    });

    expect(response.status).toBe(200);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE blacklist_events"));
    expect(updateCall?.sql).toContain("CASE WHEN amount_status = 'permanently_unavailable'");
    expect(updateCall?.binds[0]).toBe(0);
    expect(updateCall?.binds[4]).toBe("permanently_unavailable");
    expect(updateCall?.binds[5]).toBe("circle_mirror_zero_balance");
  });
});
