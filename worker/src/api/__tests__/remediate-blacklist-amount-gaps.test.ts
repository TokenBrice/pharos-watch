import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
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
      configKey: "avalanche-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    });
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
    };
    expect(body.applied).toMatchObject({
      resolved: 1,
      resolvedZero: 1,
      providerFailed: 0,
    });

    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE blacklist_events"));
    expect(updateCall).toBeTruthy();
    expect(updateCall?.binds[0]).toBe(0);
    expect(updateCall?.binds[4]).toBe("resolved");
  });
});
