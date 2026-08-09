import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../amount-repair-queue";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { migrateLegacyBlacklistIdentities } from "../legacy-identity-migration";

const TRON_USDT_CONFIG = CONTRACT_CONFIGS.find(
  (config) => config.stablecoin === "USDT" && config.chain.chainId === "tron",
)!;

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

    expect(result.ambiguousSkipped).toBe(1);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("blacklist-legacy-event-identity-migrate"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("blacklist-legacy-balance-identity-copy"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("blacklist-legacy-balance-identity-delete"))).toBe(true);
    expect(history.map((entry) => entry.sql).join("\n")).not.toContain("DELETE FROM blacklist_events");
  });

  it("drains uniquely scoped legacy balance rows against the real schema", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const insertBalance = (id: string, address: string, configKey: string | null, contract: string | null) =>
      sqlite.exec(
        `INSERT INTO blacklist_current_balances
           (id, stablecoin, chain_id, address, config_key, contract_address,
            amount_native, amount_usd, source, status, observed_at,
            last_successful_observed_at, attempt_count, last_attempted_at,
            last_error_class, consecutive_failures)
         VALUES ('${id}','USDT','tron','${address}',${configKey === null ? "NULL" : `'${configKey}'`},
                 ${contract === null ? "NULL" : `'${contract}'`},
                 '1000', 1000.0, 'current_balance', 'ok', 1774603143, 1774603143, 0, NULL, NULL, 0)`,
      );

    // A plain legacy row, plus a legacy row whose re-keyed twin already exists
    // (the conflict path the copy statement has to survive).
    insertBalance("USDT:tron:0xaaa", "0xaaa", null, null);
    insertBalance("USDT:tron:0xbbb", "0xbbb", null, null);
    const twinId = buildBlacklistContractBalanceKey(
      "USDT",
      "tron",
      "0xbbb",
      TRON_USDT_CONFIG.configKey,
      TRON_USDT_CONFIG.contractAddress,
    );
    insertBalance(twinId, "0xbbb", TRON_USDT_CONFIG.configKey, TRON_USDT_CONFIG.contractAddress);

    const result = await migrateLegacyBlacklistIdentities(db);

    expect(result.balanceMigrated).toBe(2);
    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS n FROM blacklist_current_balances WHERE config_key IS NULL AND contract_address IS NULL")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    const migrated = sqlite
      .prepare("SELECT id FROM blacklist_current_balances ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(migrated).toHaveLength(2);
    expect(migrated.every((row) => row.id.includes(TRON_USDT_CONFIG.configKey))).toBe(true);
    sqlite.close();
  });
});
