import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { reconcileBlacklistIdentities } from "../identity-reconciliation";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("reconcileBlacklistIdentities", () => {
  it("bounds each inventory page to 100 rows, resumes and remains idempotent", async () => {
    const { db, sqlite } = fixtures.open();
    const event = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url)
      VALUES (?, 'USDT', 'tron', 'Tron', 'blacklist', ?, ?, 1, 100, '', '')`);
    const balance = sqlite.prepare(`INSERT INTO blacklist_current_balances
      (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at)
      VALUES (?, 'USDT', 'tron', ?, 42, 42, 'current_balance', 'resolved', 100)`);
    for (let index = 1; index <= 101; index++) {
      const suffix = index.toString().padStart(3, "0");
      const address = `41${index.toString(16).padStart(40, "0")}`;
      event.run(`event${suffix}`, address, suffix);
      balance.run(`snapshot${suffix}`, address);
    }
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_events WHERE address LIKE '41%'").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_current_balances WHERE id LIKE 'snapshot%'").get()).toEqual({ n: 1 });
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_events WHERE address LIKE '41%'").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n, SUM(amount_native) AS amount FROM blacklist_current_balances").get()).toEqual({ n: 101, amount: 4242 });
    const before = sqlite.prepare("SELECT * FROM blacklist_current_balances ORDER BY id").all();
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT * FROM blacklist_current_balances ORDER BY id").all()).toEqual(before);
  });
  it("avoids no-op row writes after wrapping while still reconciling operator imports", async () => {
    const { db, sqlite } = fixtures.open();
    const address = `0x${"a".repeat(40)}`;
    const legacyAddress = `41${address.slice(2)}`;
    const balanceId = buildBlacklistContractBalanceKey("USDT", "tron", address);
    const event = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url)
      VALUES (?, 'USDT', ?, '', 'blacklist', ?, ?, 1, 100, '', '')`);
    const balance = sqlite.prepare(`INSERT INTO blacklist_current_balances
      (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at)
      VALUES (?, 'USDT', 'tron', ?, ?, ?, 'current_balance', 'resolved', ?)`);
    event.run("tron-tx-0", "tron", legacyAddress, "tx");
    event.run("ethereum-0xabc-0x1", "ethereum", address, "0xabc");
    balance.run("legacy-snapshot", legacyAddress, 42, 42, 100);
    sqlite.exec(`CREATE TEMP TABLE reconciliation_writes (kind TEXT);
      CREATE TEMP TRIGGER event_reconciled AFTER UPDATE ON blacklist_events
        BEGIN INSERT INTO reconciliation_writes VALUES ('event'); END;
      CREATE TEMP TRIGGER balance_inserted AFTER INSERT ON blacklist_current_balances
        BEGIN INSERT INTO reconciliation_writes VALUES ('balance'); END;
      CREATE TEMP TRIGGER balance_deleted AFTER DELETE ON blacklist_current_balances
        BEGIN INSERT INTO reconciliation_writes VALUES ('balance'); END;`);

    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reconciliation_writes").get()?.n).toBeGreaterThan(0);
    sqlite.exec("DELETE FROM reconciliation_writes");
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reconciliation_writes").get()).toEqual({ n: 0 });

    event.run("ethereum-0xabc-1", "ethereum", address, "0xabc");
    balance.run("operator-snapshot", legacyAddress, 50, 50, 200);
    sqlite.exec("DELETE FROM reconciliation_writes");
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT suppression_reason FROM blacklist_events WHERE id = 'ethereum-0xabc-1'").get())
      .toEqual({ suppression_reason: "duplicate_log_identity" });
    expect(sqlite.prepare("SELECT id, address, amount_native FROM blacklist_current_balances").all())
      .toEqual([{ id: balanceId, address, amount_native: 50 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reconciliation_writes").get()?.n).toBeGreaterThan(0);
    sqlite.exec("DELETE FROM reconciliation_writes");
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reconciliation_writes").get()).toEqual({ n: 0 });
  });
});
