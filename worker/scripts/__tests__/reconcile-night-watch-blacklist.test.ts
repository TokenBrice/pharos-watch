import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import frozenManifestJson from "../data/night-watch-blacklist-manifest-2026-07-09.json";
import {
  parseReconciliationArgs,
  runNightWatchBlacklistReconciliation,
  validateFrozenManifest,
  type FrozenManifest,
  type FrozenManifestEvent,
} from "../reconcile-night-watch-blacklist";
import type { RemoteD1Client } from "../lib/remote-d1";

const SCRIPT_NAME = "worker/scripts/reconcile-night-watch-blacklist.ts";
const frozenManifest = frozenManifestJson as FrozenManifest;
const bookmark = "00001d80-000109c2-000050a4-9f8ee3f29d2234f14494a399c6769f35";
const nowMs = frozenManifest.cutoffInclusive + 15 * 60_000;
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

function amountNative(event: FrozenManifestEvent): number | null {
  return event.amountRaw == null ? null : Number(BigInt(event.amountRaw)) / 1_000_000;
}

function balanceProjection(events: readonly FrozenManifestEvent[]): Map<string, number> {
  const latest = new Map<string, FrozenManifestEvent>();
  for (const event of events) latest.set(event.address, event);
  const balances = new Map<string, number>();
  for (const event of latest.values()) {
    if (event.eventType === "unblacklist") continue;
    balances.set(event.address, event.eventType === "destroy" ? amountNative(event)! : 1);
  }
  return balances;
}

function makeD1(initiallyApplied = false): {
  d1: RemoteD1Client;
  executeStatements: ReturnType<typeof vi.fn>;
  setApplied(value: boolean): void;
} {
  let applied = initiallyApplied;
  const balances = balanceProjection(frozenManifest.events);
  const executeStatements = vi.fn(() => {
    applied = true;
  });
  const d1: RemoteD1Client = {
    query: (<T>(sql: string): T[] => {
      if (sql.includes("FROM blacklist_sync_state")) {
        return [
          {
            config_key: frozenManifest.configKey,
            cursor_value: applied ? frozenManifest.cutoffInclusive : frozenManifest.cursorExclusive,
            last_block: applied ? frozenManifest.cutoffInclusive : frozenManifest.cursorExclusive,
            last_observed_safe_head: frozenManifest.cutoffInclusive,
          },
          ...Array.from({ length: 7 }, (_, index) => ({
            config_key: `arbitrum-test-${index}`,
            cursor_value: 500_000_000 + index,
            last_block: 500_000_000 + index,
            last_observed_safe_head: 500_000_000 + index,
          })),
        ] as T[];
      }
      if (sql.includes("FROM blacklist_current_balances")) {
        if (!applied) return [];
        const requestedAddresses = new Set(
          [...sql.matchAll(/'(0x[a-f0-9]{40})'/gi)].map((match) => match[1]!.toLowerCase()),
        );
        return [...balances]
          .filter(([address]) => requestedAddresses.has(address.toLowerCase()))
          .map(([address, amount]) => ({
            address,
            amount_native: amount,
            source: "reconciliation_current_balance",
            config_key: frozenManifest.configKey,
            contract_address: frozenManifest.contractAddress,
          })) as T[];
      }
      if (sql.includes("FROM blacklist_events")) {
        if (!applied) return [];
        return frozenManifest.events.map((event) => ({
          id: event.id,
          tx_hash: event.txHash,
          event_type: event.eventType,
          event_signature: event.eventSignature,
          address: event.address,
          block_number: event.blockNumber,
          timestamp: Math.floor(event.blockTimestampMs / 1000),
          amount_native: amountNative(event),
          source_event_index: event.eventIndex,
        })) as T[];
      }
      return [];
    }) as RemoteD1Client["query"],
    queryRaw: () => "[]",
    executeStatements,
  };
  return {
    d1,
    executeStatements,
    setApplied: (value) => {
      applied = value;
    },
  };
}

function options(apply: boolean) {
  return {
    apply,
    help: false,
    database: "stablecoin-db",
    timeoutMs: 1_000,
    timeTravelBookmark: apply ? bookmark : null,
    trongridApiKey: null,
    balanceProviderUrl: null,
  };
}

function dependencies(d1: RemoteD1Client) {
  return {
    d1,
    now: () => nowMs,
    loadFrozenEvents: async () => frozenManifest.events,
    loadTailEvents: async () => frozenManifest.events,
    loadBalanceAmounts: async () => new Map(frozenManifest.events.map((event) => [event.address, 1])),
    verifyBookmark: vi.fn(() => true),
  };
}

describe("Night Watch blacklist reconciliation", () => {
  it("pins the exact audited manifest contract", () => {
    expect(() => validateFrozenManifest()).not.toThrow();
    expect(frozenManifest.expected).toEqual({
      eventCount: 86,
      byEventType: { blacklist: 72, unblacklist: 3, destroy: 11 },
      destroyedAmountRaw: "8874287612325",
      destroyedAmountNative: "8874287.612325",
    });
    expect(new Set(frozenManifest.events.map((event) => event.id)).size).toBe(86);
  });

  it("defaults to dry-run and requires a bookmark for mutation", () => {
    expect(parseReconciliationArgs([])).toMatchObject({ apply: false, timeTravelBookmark: null });
    expect(() => parseReconciliationArgs(["--execute", "--confirm", SCRIPT_NAME])).toThrow(/time-travel-bookmark/);
    expect(
      parseReconciliationArgs(["--execute", "--confirm", SCRIPT_NAME, "--time-travel-bookmark", bookmark]),
    ).toMatchObject({ apply: true, timeTravelBookmark: bookmark });
  });

  it("performs a read-only manifest, balance, and frontier dry-run", async () => {
    const { d1, executeStatements } = makeD1();
    const summary = await runNightWatchBlacklistReconciliation(options(false), dependencies(d1));

    expect(summary).toMatchObject({
      mode: "dry-run",
      status: "ready",
      expectedEventCount: 86,
      upstreamFrozenEventCount: 86,
      presentEventCount: 0,
      insertedEventCount: 0,
      missingEventCount: 86,
      destroyedAmountExpectedRaw: "8874287612325",
    });
    expect(executeStatements).not.toHaveBeenCalled();
  });

  it("applies only idempotent targeted writes and verifies exact parity", async () => {
    const { d1, executeStatements } = makeD1();
    const outOfManifestTailEvent: FrozenManifestEvent = {
      id: `tron-${"f".repeat(64)}-0`,
      eventType: "unblacklist",
      eventSignature: "RemovedBlackList(address)",
      txHash: "f".repeat(64),
      eventIndex: 0,
      blockNumber: frozenManifest.events[frozenManifest.events.length - 1]!.blockNumber + 1,
      blockTimestampMs: frozenManifest.cutoffInclusive,
      address: "0x00000000000000000000000000000000000000ff",
      amountRaw: null,
    };
    const deps = {
      ...dependencies(d1),
      loadTailEvents: async () => [...frozenManifest.events, outOfManifestTailEvent],
    };
    const summary = await runNightWatchBlacklistReconciliation(options(true), deps);

    expect(summary).toMatchObject({
      mode: "apply",
      status: "verified",
      bookmarkVerified: true,
      presentEventCount: 86,
      insertedEventCount: 86,
      missingEventCount: 0,
      duplicateIdentityCount: 0,
      identityConflictCount: 0,
      destroyedAmountActualRaw: "8874287612325",
      unresolvedManifestGapCount: 0,
      tron: { atSafeHead: true },
      arbitrum: { configCount: 7, atSafeHeadCount: 7 },
    });
    expect(deps.verifyBookmark).toHaveBeenCalledTimes(2);
    expect(executeStatements).toHaveBeenCalledTimes(2);
    const mutationStatements = executeStatements.mock.calls[0]?.[0] as string[];
    expect(mutationStatements.filter((sql) => sql.includes("INSERT INTO blacklist_events"))).toHaveLength(87);
    expect(mutationStatements.some((sql) => sql.includes("night-watch-reconciliation:trongrid"))).toBe(true);
    expect(mutationStatements.join("\n")).not.toContain("DELETE FROM blacklist_events");
    expect(mutationStatements.join("\n")).not.toContain("DELETE FROM blacklist_current_balances");

    const sqlite = new DatabaseSync(":memory:");
    const migrationFiles = readdirSync(migrationsDir)
      .filter((filename) => filename.endsWith(".sql"))
      .filter((filename) => filename.startsWith("0000_") || Number(filename.slice(0, 4)) >= 72)
      .sort();
    for (const filename of migrationFiles) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- filenames come from the migrations directory listing above.
      sqlite.exec(readFileSync(resolve(migrationsDir, filename), "utf8"));
    }
    for (const statement of mutationStatements) sqlite.exec(statement);
    const finalStatements = executeStatements.mock.calls[1]?.[0] as string[];
    for (const statement of finalStatements) sqlite.exec(statement);
    const stored = sqlite
      .prepare("SELECT COUNT(*) AS count FROM blacklist_events WHERE reconciliation_manifest_id = ?")
      .get(frozenManifest.manifestId) as { count: number };
    expect(stored.count).toBe(86);
    const tail = sqlite
      .prepare("SELECT reconciliation_manifest_id, reconciliation_run_id FROM blacklist_events WHERE id = ?")
      .get(outOfManifestTailEvent.id) as {
      reconciliation_manifest_id: string | null;
      reconciliation_run_id: string | null;
    };
    expect(tail).toEqual({
      reconciliation_manifest_id: null,
      reconciliation_run_id: `${frozenManifest.manifestId}:${bookmark}`,
    });
    sqlite.close();
  });

  it("preserves a concurrently newer balance instead of overwriting it", async () => {
    const { d1, executeStatements } = makeD1();
    await runNightWatchBlacklistReconciliation(options(true), dependencies(d1));
    const mutationStatements = executeStatements.mock.calls[0]?.[0] as string[];
    const balanceStatement = mutationStatements.find((sql) => sql.includes("INSERT INTO blacklist_current_balances"));
    expect(balanceStatement).toContain(
      "COALESCE(blacklist_current_balances.observed_at, 0) <= excluded.observed_at",
    );
    expect(balanceStatement).toContain(
      "COALESCE(blacklist_current_balances.last_attempted_at, 0) <= excluded.last_attempted_at",
    );
    expect(balanceStatement).toContain("blacklist_current_balances.amount_native IS excluded.amount_native");

    const sqlite = new DatabaseSync(":memory:");
    try {
      const migrationFiles = readdirSync(migrationsDir)
        .filter((filename) => filename.endsWith(".sql"))
        .filter((filename) => filename.startsWith("0000_") || Number(filename.slice(0, 4)) >= 72)
        .sort();
      for (const filename of migrationFiles) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- filenames come from the migrations directory listing above.
        sqlite.exec(readFileSync(resolve(migrationsDir, filename), "utf8"));
      }
      sqlite.exec(balanceStatement!);
      const inserted = sqlite
        .prepare("SELECT id, observed_at, last_attempted_at FROM blacklist_current_balances LIMIT 1")
        .get() as { id: string; observed_at: number; last_attempted_at: number };
      sqlite
        .prepare(
          `UPDATE blacklist_current_balances
              SET amount_native = 999,
                  amount_usd = 999
            WHERE id = ?`,
        )
        .run(inserted.id);

      sqlite.exec(balanceStatement!);

      const preserved = sqlite
        .prepare(
          `SELECT amount_native, observed_at, last_attempted_at
             FROM blacklist_current_balances
            WHERE id = ?`,
        )
        .get(inserted.id);
      expect(preserved).toEqual({
        amount_native: 999,
        observed_at: inserted.observed_at,
        last_attempted_at: inserted.last_attempted_at,
      });
    } finally {
      sqlite.close();
    }
  });

  it("marks reconciliation failed when a concurrent balance prevents exact replay parity", async () => {
    const fixture = makeD1();
    const originalQuery = fixture.d1.query;
    fixture.d1.query = (<T>(sql: string): T[] => {
      const rows = originalQuery<T>(sql);
      if (sql.includes("FROM blacklist_current_balances") && fixture.executeStatements.mock.calls.length > 0) {
        const balances = rows as Array<Record<string, unknown>>;
        if (balances[0]) balances[0].amount_native = 999;
      }
      return rows;
    }) as RemoteD1Client["query"];

    const summary = await runNightWatchBlacklistReconciliation(options(true), dependencies(fixture.d1));

    expect(summary.status).toBe("failed");
    expect(summary.balanceReplayMatchingCount).toBeLessThan(summary.balanceReplayExpectedCount);
    expect(summary.unresolvedManifestGapCount).toBeGreaterThan(0);
    expect(summary.samples.balanceMismatches).not.toEqual([]);
  });

  it("requires exact contract and config identity for balance replay parity", async () => {
    const fixture = makeD1();
    const originalQuery = fixture.d1.query;
    fixture.d1.query = (<T>(sql: string): T[] => {
      const rows = originalQuery<T>(sql);
      if (sql.includes("FROM blacklist_current_balances") && fixture.executeStatements.mock.calls.length > 0) {
        const balances = rows as Array<Record<string, unknown>>;
        if (balances[0]) balances[0].contract_address = "wrong-contract";
      }
      return rows;
    }) as RemoteD1Client["query"];

    const summary = await runNightWatchBlacklistReconciliation(options(true), dependencies(fixture.d1));

    expect(summary.status).toBe("failed");
    expect(summary.balanceReplayMatchingCount).toBeLessThan(summary.balanceReplayExpectedCount);
    expect(summary.samples.balanceMismatches).not.toEqual([]);
  });

  it("is idempotent when every frozen identity already exists", async () => {
    const { d1 } = makeD1(true);
    const summary = await runNightWatchBlacklistReconciliation(options(true), dependencies(d1));

    expect(summary.status).toBe("verified");
    expect(summary.insertedEventCount).toBe(0);
    expect(summary.presentEventCount).toBe(86);
    expect(summary.missingEventCount).toBe(0);
  });

  it("refuses mutation when the supplied bookmark is not current", async () => {
    const { d1, executeStatements } = makeD1();
    const deps = { ...dependencies(d1), verifyBookmark: vi.fn(() => false) };

    await expect(runNightWatchBlacklistReconciliation(options(true), deps)).rejects.toThrow(/bookmark/);
    expect(executeStatements).not.toHaveBeenCalled();
  });

  it("refuses upstream drift before reading or writing D1", async () => {
    const { d1, executeStatements } = makeD1();
    const drifted = frozenManifest.events.slice(1);

    await expect(
      runNightWatchBlacklistReconciliation(options(false), {
        ...dependencies(d1),
        loadFrozenEvents: async () => drifted,
      }),
    ).rejects.toThrow(/no longer match/);
    expect(executeStatements).not.toHaveBeenCalled();
  });
});
