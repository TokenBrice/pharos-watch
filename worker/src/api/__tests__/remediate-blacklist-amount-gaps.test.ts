import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import type { ChainRpcConfig } from "../../lib/chain-registry";

stubCryptoForAuth();

vi.mock("../blacklist-summary", () => ({}));
vi.mock("../../cron/blacklist/balance-providers", () => ({
  fetchEvmTokenBalance: vi.fn(),
}));

const { handleRemediateBlacklistAmountGaps } = await import("../remediate-blacklist-amount-gaps");
const { fetchEvmTokenBalance } = await import("../../cron/blacklist/balance-providers");

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
  it("rejects malformed JSON bodies", async () => {
    const response = await handleRemediateBlacklistAmountGaps(
      mockD1([], { requireMatch: false }),
      makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      true,
      makeApiRequest("/api/remediate-blacklist-amount-gaps", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      testChainRpcs,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("rejects non-object JSON bodies", async () => {
    const response = await handleRemediateBlacklistAmountGaps(
      mockD1([], { requireMatch: false }),
      makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      true,
      makeApiRequest("/api/remediate-blacklist-amount-gaps", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not-an-object"]),
      }),
      testChainRpcs,
    );

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

    const response = await handleRemediateBlacklistAmountGaps(
      db,
      makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      true,
      request,
      testChainRpcs,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
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

    const response = await handleRemediateBlacklistAmountGaps(
      db,
      makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      true,
      request,
      testChainRpcs,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
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

    const response = await handleRemediateBlacklistAmountGaps(
      db,
      makeApiUrl("/api/remediate-blacklist-amount-gaps?onlyMissingProvenance=true"),
      true,
      request,
      testChainRpcs,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
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

    const response = await handleRemediateBlacklistAmountGaps(
      db,
      makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      true,
      request,
      testChainRpcs,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { filters: { maxAttempts: number } };
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

    const response = await handleRemediateBlacklistAmountGaps(
      db,
      makeApiUrl("/api/remediate-blacklist-amount-gaps"),
      true,
      request,
      testChainRpcs,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
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
});
