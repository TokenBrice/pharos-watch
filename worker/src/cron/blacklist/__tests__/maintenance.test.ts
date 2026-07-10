import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../amount-repair-queue";
import { migrateLegacyBlacklistIdentities } from "../legacy-identity-migration";
import { boundBlacklistProviderFailureSamples, persistBlacklistProviderScanTelemetry } from "../provider-telemetry";

describe("blacklist maintenance foundations", () => {
  it("queues unresolved amounts and records bounded retry backoff", async () => {
    const db = mockD1();
    await refreshBlacklistAmountRepairQueue(db, 1_700_000_000);
    await buildBlacklistAmountRepairQueueUpdate(db, {
      eventId: "event-1",
      outcome: "retry",
      attemptedAt: 1_700_000_100,
      priorAttempts: 2,
      errorClass: "provider_timeout",
    }).run();

    const sql = db
      .getHistory()
      .map((entry) => entry.sql)
      .join("\n");
    expect(sql).toContain("blacklist-amount-repair-queue-enqueue");
    expect(sql).toContain("blacklist-amount-repair-queue-reconcile-resolved");
    expect(sql).toContain("blacklist-amount-repair-queue-release-expired");
    const finish = db.getHistory().find((entry) => entry.sql.includes("blacklist-amount-repair-queue-finish"));
    expect(finish?.binds).toEqual([
      "retry",
      1_700_001_300,
      "provider_timeout",
      1_700_000_100,
      0,
      1_700_000_100,
      "event-1",
    ]);
  });

  it("migrates only uniquely scoped legacy identities without a global reset", async () => {
    const db = mockD1([
      {
        match: "blacklist-legacy-event-identities",
        rows: [
          {
            id: "event-1",
            stablecoin: "USDT",
            chain_id: "tron",
            address: "0x1111111111111111111111111111111111111111",
          },
          {
            id: "event-ambiguous",
            stablecoin: "USDT",
            chain_id: "optimism",
            address: "0x2222222222222222222222222222222222222222",
          },
        ],
      },
      {
        match: "blacklist-legacy-balance-identities",
        rows: [
          {
            id: "USDT:tron:legacy",
            stablecoin: "USDT",
            chain_id: "tron",
            address: "0x1111111111111111111111111111111111111111",
          },
        ],
      },
    ]);

    const result = await migrateLegacyBlacklistIdentities(db);

    expect(result).toEqual({ eventMigrated: 1, balanceMigrated: 1, ambiguousSkipped: 1 });
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("blacklist-legacy-event-identity-migrate"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("blacklist-legacy-balance-identity-copy"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("blacklist-legacy-balance-identity-delete"))).toBe(true);
    expect(history.map((entry) => entry.sql).join("\n")).not.toContain("DELETE FROM blacklist_events");
  });

  it("bounds retained provider failure samples and persists call/depth telemetry", async () => {
    expect(boundBlacklistProviderFailureSamples(["first\nline", "x".repeat(200), "third", "fourth", "fifth"])).toEqual([
      "first line",
      "x".repeat(120),
      "third",
      "fourth",
    ]);

    const db = mockD1();
    const written = await persistBlacklistProviderScanTelemetry(
      db,
      [
        {
          configKey: "arbitrum-contract",
          chainId: "arbitrum",
          providerMode: "rpc-or-topics",
          coverageOutcome: "complete",
          fromCursor: 480_000_000,
          scannedToCursor: 480_025_000,
          safeHead: 482_000_000,
          fetchedRowCount: 13,
          insertedRowCount: 13,
          providerCallCount: 4,
          maxSplitDepth: 2,
          failureSamples: ["bounded"],
          observedAt: 1_700_000_000,
        },
      ],
      1_700_000_000,
    );

    expect(written).toBe(1);
    const insert = db.getHistory().find((entry) => entry.sql.includes("blacklist-provider-scan-telemetry-insert"));
    expect(insert?.binds).toContain(4);
    expect(insert?.binds).toContain(2);
    expect(insert?.binds).toContain('["bounded"]');
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-provider-scan-telemetry-prune"))).toBe(true);
  });
});
