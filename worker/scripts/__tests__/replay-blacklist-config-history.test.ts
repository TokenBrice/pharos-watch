import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getBlacklistConfigsForSymbolAndChain } from "../../src/lib/blacklist-contracts";
import { parseEvmLogsWithCoverage } from "../../src/cron/blacklist/evm-source";
import { buildBlacklistEventInsert } from "../../src/cron/blacklist/persistence";
import type { AlchemyLogEntry } from "../../src/lib/alchemy-logs";
import { BLACKLIST_CURRENT_BALANCE_COLUMNS, BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY, buildBlacklistCurrentBalanceValues } from "../../src/lib/blacklist-current-balances";
import { bindBackfillSql } from "../lib/backfill-d1";
import { parseReplayArgs, runConfigHistoryReplay, fetchReplayLogs, SCRIPT_NAME, type ReplayDependencies } from "../replay-blacklist-config-history";
import { sqliteRemoteD1, seedDerivedCaches, derivedCacheRows, ledgerRows, observation } from "./blacklist-current-balance-maintenance.test-support";

const fixtures = createLatestSchemaFixtureTracker();
const config = getBlacklistConfigsForSymbolAndChain("USDT", "avalanche")[0]!;
const ADDRESS = `0x${"1".padStart(40, "0")}`;
const HASH = `0x${"a".repeat(64)}`;
const NOW = Math.floor(Date.now() / 1000);
const args = ["--config-key", config.configKey, "--from-block", "100", "--to-block", "200"];
afterEach(() => { fixtures.closeAll(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function log(eventType: "blacklist" | "unblacklist" | "destroy" = "blacklist", block = 110, index = 1): AlchemyLogEntry {
  const event = config.events.find((entry) => entry.eventType === eventType)!;
  return { address: config.contractAddress, topics: [event.topicHash, `0x${ADDRESS.slice(2).padStart(64, "0")}`],
    data: event.hasAmount ? `0x${(12_500_000n).toString(16).padStart(64, "0")}` : "0x",
    blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${String(index).padStart(64, "0")}`,
    transactionIndex: "0x0", logIndex: `0x${index.toString(16)}`, blockHash: HASH, removed: false };
}
function setup(logs: AlchemyLogEntry[] = [log()]) {
  vi.stubEnv("BLACKLIST_REPLAY_RPC_URL", "https://rpc.example.invalid/secret-key");
  const { sqlite } = fixtures.open();
  sqlite.prepare("INSERT INTO blacklist_sync_state(config_key, last_block, cursor_kind, cursor_value) VALUES (?, 200, 'evm_block', 200)").run(config.configKey);
  sqlite.prepare("INSERT INTO cache(key, value, updated_at) VALUES (?, 'paused', ?)").run(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY, NOW);
  seedDerivedCaches(sqlite);
  const { d1, imports } = sqliteRemoteD1(sqlite, { batchSize: 1 });
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === "eth_chainId") return `0x${config.chain.evmChainId!.toString(16)}`;
    if (method === "eth_getBlockByNumber") return { number: params[0] === "latest" ? "0x12c" : params[0], hash: HASH, timestamp: `0x${NOW.toString(16)}` };
    if (method === "eth_call") return `0x${(42_000_000n).toString(16).padStart(64, "0")}`;
    throw new Error(`Unexpected ${method}`);
  });
  const dependencies: ReplayDependencies = { d1, rpc, now: () => NOW * 1000,
    captureRestorePoint: vi.fn(() => "captured-bookmark"), loadLogs: vi.fn(async () => ({ logs, timestamps: new Map(logs.map((entry) => [Number(entry.blockNumber), NOW - 100])) })) };
  const options = parseReplayArgs(args);
  const execute = () => runConfigHistoryReplay({ ...options, apply: true }, dependencies);
  const insert = (entry: AlchemyLogEntry, id?: string) => {
    const row = parseEvmLogsWithCoverage(config, [entry], new Map([[Number(entry.blockNumber), NOW - 100]])).rows[0]!;
    if (id) row.id = id;
    const statement = buildBlacklistEventInsert(row);
    sqlite.exec(bindBackfillSql(statement.sql, statement.bindings));
    return row;
  };
  return { sqlite, d1, imports, rpc, dependencies, options, execute, insert };
}

describe("configured blacklist history replay", () => {
  it("defaults to read-only and requires execution confirmation without an operator bookmark", () => {
    expect(parseReplayArgs(args)).toMatchObject({ apply: false, configKey: config.configKey, fromBlock: 100, toBlock: 200 });
    expect(() => parseReplayArgs([...args, "--execute"])).toThrow(/live mutation requires/);
    expect(parseReplayArgs([...args, "--execute", "--confirm", SCRIPT_NAME]).apply).toBe(true);
    expect(() => parseReplayArgs([...args, "--time-travel-bookmark", "obsolete-bookmark"])).toThrow(/Unknown option/);
    expect(parseReplayArgs(["-h"]).help).toBe(true);
  });
  it("rejects unknown configs, non-EVM configs, invalid windows, unknown/duplicate options and conflicting modes", () => {
    expect(() => parseReplayArgs(["--config-key", "unknown", "--from-block", "1", "--to-block", "2"])).toThrow(/existing EVM/);
    const tron = getBlacklistConfigsForSymbolAndChain("USDT", "tron")[0]!;
    expect(() => parseReplayArgs(["--config-key", tron.configKey, "--from-block", "1", "--to-block", "2"])).toThrow(/existing EVM/);
    expect(() => parseReplayArgs([...args, "--bogus"])).toThrow(/Unknown option/);
    expect(() => parseReplayArgs([...args, "--to-block", "400"])).toThrow(/only be specified once/);
    expect(() => parseReplayArgs(["--config-key", config.configKey, "--from-block", "200", "--to-block", "100"])).toThrow(/must not exceed/);
    expect(() => parseReplayArgs(["--config-key", config.configKey, "--from-block", "1junk", "--to-block", "200"])).toThrow(/safe decimal/);
    expect(() => parseReplayArgs([...args, "--execute", "--dry-run"])).toThrow(/mutually exclusive/);
    expect(() => parseReplayArgs([...args, "--local"])).toThrow(/not supported/);
  });
  it("refuses a window beyond the cursor before any RPC reads or D1 writes", async () => {
    const fixture = setup();
    await expect(runConfigHistoryReplay({ ...fixture.options, toBlock: 201 }, fixture.dependencies)).rejects.toThrow(/beyond current cursor/);
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(fixture.imports).toEqual([]);
  });
  it("dry-run computes the missing diff and amounts without modifying any D1 state", async () => {
    const fixture = setup();
    const before = fixture.sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const result = await runConfigHistoryReplay(fixture.options, fixture.dependencies);
    expect(result).toMatchObject({ mode: "dry-run", missingEventCount: 1, insertedEventCount: 0, affectedBalanceCount: 1 });
    expect(result.timeTravelBookmark).toBeNull();
    expect(fixture.dependencies.captureRestorePoint).not.toHaveBeenCalled();
    expect(fixture.imports).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_events").get()).toEqual({ n: 0 });
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_action_audit").get()).toEqual({ n: 0 });
    expect(fixture.sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
  });
  it("deduplicates RPC repeats and decimal/hex existing identities without touching prior rows", async () => {
    const first = log("blacklist", 110, 10);
    const second = log("destroy", 120, 11);
    const fixture = setup([first, first, second]);
    const prior = fixture.insert(first, `avalanche-${first.transactionHash}-10`);
    const before = fixture.sqlite.prepare("SELECT * FROM blacklist_events WHERE id = ?").get(prior.id);
    const result = await fixture.execute();
    expect(result).toMatchObject({ canonicalEventCount: 2, existingEventCount: 1, insertedEventCount: 1, status: "verified" });
    expect(fixture.sqlite.prepare("SELECT * FROM blacklist_events WHERE id = ?").get(prior.id)).toEqual(before);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_events").get()).toEqual({ n: 2 });
    expect(fixture.imports).toHaveLength(1);
  });
  it("records canonical provenance, evidence and audit; rebuilds only affected identities and invalidates exact caches", async () => {
    const fixture = setup([log("destroy")]);
    // Unrelated contract-scoped observation survives the replay byte-for-byte.
    fixture.sqlite.exec(`INSERT INTO blacklist_current_balances (id,stablecoin,chain_id,address,config_key,contract_address,amount_native,amount_usd,source,status,observed_at,attempt_count,consecutive_failures)
      VALUES ('unrelated','USDT','avalanche','0xother','other-config','0xother',99,99,'current_balance','resolved',1,1,0)`);
    const retained = ledgerRows(fixture.sqlite);
    const result = await fixture.execute();
    expect(fixture.dependencies.captureRestorePoint).toHaveBeenCalledExactlyOnceWith("stablecoin-db");
    expect(result).toMatchObject({ status: "verified", insertedEventCount: 1, cursorBefore: 200, cursorAfter: 200 });
    const saved = fixture.sqlite.prepare("SELECT * FROM blacklist_events").get();
    expect(saved).toMatchObject({ config_key: config.configKey, contract_address: config.contractAddress,
      amount_native: 12.5, amount_source: "event", reconciliation_run_id: result.runId,
      reconciliation_manifest_id: `sha256:${result.evidenceSha256}`, provenance_source: `${SCRIPT_NAME}:${result.evidenceSha256}`, provenance_observed_at: NOW });
    const audit = fixture.sqlite.prepare("SELECT * FROM admin_action_audit").get() as { details_json: string; action: string; result: string };
    expect(audit).toMatchObject({ action: "replay-blacklist-config-history", result: "ok" });
    const details = JSON.parse(audit.details_json);
    expect(details).toMatchObject({ tool: SCRIPT_NAME, runId: result.runId, evidenceSha256: result.evidenceSha256,
      configKey: config.configKey, status: "applied", insertedEventCount: 1, missingEventCount: 0, plannedMissingEventCount: 1 });
    expect(details.evidence.logs).toHaveLength(1);
    expect(details.timeTravelBookmark).toBe("captured-bookmark");
    expect(details.evidence.timeTravelBookmark).toBe("captured-bookmark");
    expect(createHash("sha256").update(JSON.stringify(details.evidence)).digest("hex")).toBe(result.evidenceSha256);
    expect(audit.details_json).not.toContain("secret-key");
    expect(fixture.sqlite.prepare("SELECT amount_native,source,config_key FROM blacklist_current_balances WHERE address = ?").get(ADDRESS))
      .toEqual({ amount_native: 12.5, source: "destroy_event", config_key: config.configKey });
    expect(fixture.sqlite.prepare("SELECT * FROM blacklist_current_balances WHERE id = 'unrelated'").get()).toEqual(retained[0]);
    expect(derivedCacheRows(fixture.sqlite)).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT value FROM cache WHERE key = 'unrelated-cache'").get()).toEqual({ value: "{}" });
    expect(fixture.sqlite.prepare("SELECT cursor_value,last_block FROM blacklist_sync_state WHERE config_key = ?").get(config.configKey)).toEqual({ cursor_value: 200, last_block: 200 });
    const writes = fixture.imports.length;
    expect(await fixture.execute()).toMatchObject({ status: "unchanged", missingEventCount: 0 });
    expect(fixture.imports).toHaveLength(writes);
  });
  it("projects RPC block responses so repeated header evidence stays below D1's statement limit", async () => {
    const fixture = setup();
    fixture.dependencies.rpc = async (method, params) => {
      if (method === "eth_getBlockByNumber") return {
        number: params[0] === "latest" ? "0x12c" : params[0], hash: HASH, timestamp: `0x${NOW.toString(16)}`,
        transactions: Array.from({ length: 2_000 }, () => HASH),
        unusedProviderField: "not-header-evidence",
      };
      return fixture.rpc(method, params);
    };
    const executeStatements = fixture.d1.executeStatements;
    fixture.d1.executeStatements = (statements, prefix) => {
      const auditInsert = statements[0]!.split(";\n")[0]!;
      expect(Buffer.byteLength(auditInsert)).toBeLessThan(100_000);
      executeStatements(statements, prefix);
    };
    await fixture.execute();
    const audit = fixture.sqlite.prepare("SELECT details_json FROM admin_action_audit").get() as { details_json: string };
    const evidence = JSON.parse(audit.details_json).evidence;
    expect(evidence.currentHead).toEqual({ number: "0x12c", hash: HASH, timestamp: `0x${NOW.toString(16)}` });
    expect(evidence.observations).toHaveLength(1);
    for (const observation of evidence.observations) {
      expect(Object.keys(observation.block).sort()).toEqual(["hash", "number", "timestamp"]);
    }
    expect(audit.details_json).not.toContain("transactions");
    expect(audit.details_json).not.toContain("unusedProviderField");
  });
  it("keeps historical amounts null when pinned archive reads fail; never substitutes current balances", async () => {
    const fixture = setup();
    fixture.dependencies.rpc = async (method, params) => {
      if (method === "eth_call") throw new Error("archive unsupported");
      return fixture.rpc(method, params);
    };
    await fixture.execute();
    expect(fixture.sqlite.prepare("SELECT amount_native,amount_usd_at_event,amount_status FROM blacklist_events").get())
      .toEqual({ amount_native: null, amount_usd_at_event: null, amount_status: "provider_failed" });
    expect(fixture.sqlite.prepare("SELECT amount_native,status FROM blacklist_current_balances").get())
      .toEqual({ amount_native: null, status: "provider_failed" });
  });
  it("uses real RPC envelopes for current snapshots without admitting block-before state as event amounts", async () => {
    const fixture = setup();
    fixture.dependencies.rpc = undefined;
    const calls: Array<{ method: string; params: unknown[] }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      calls.push(request);
      let result: unknown;
      if (request.method === "eth_chainId") result = `0x${config.chain.evmChainId!.toString(16)}`;
      else if (request.method === "eth_getBlockByNumber") result = {
        number: request.params[0] === "latest" ? "0x12c" : request.params[0],
        hash: request.params[0] === "latest" ? `0x${"b".repeat(64)}` : HASH,
        timestamp: `0x${NOW.toString(16)}`,
      };
      else if (request.method === "eth_call") {
        result = `0x${(42_000_000n).toString(16).padStart(64, "0")}`;
      } else throw new Error(`Unexpected RPC ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
    }));
    await fixture.execute();
    expect(fixture.sqlite.prepare("SELECT amount_native,amount_source FROM blacklist_events").get())
      .toEqual({ amount_native: null, amount_source: "unavailable" });
    expect(fixture.sqlite.prepare("SELECT amount_native,source FROM blacklist_current_balances").get())
      .toEqual({ amount_native: 42, source: "current_balance" });
    expect(calls.filter((call) => call.method === "eth_getBlockByNumber").map((call) => call.params[0]))
      .toEqual(["latest"]);
    expect(calls.filter((call) => call.method === "eth_call").map((call) => call.params[1])).toEqual([
      { blockHash: `0x${"b".repeat(64)}`, requireCanonical: true },
    ]);
  });
  it("does not substitute an unproved pre-freeze PAXG amount after an observed frozen zero", async () => {
    const fixture = setup();
    const paxg = getBlacklistConfigsForSymbolAndChain("PAXG", "ethereum")[0]!;
    fixture.sqlite.prepare("INSERT OR REPLACE INTO blacklist_sync_state(config_key,last_block,cursor_kind,cursor_value) VALUES (?,200,'evm_block',200)").run(paxg.configKey);
    const freeze = { ...log(), address: paxg.contractAddress,
      topics: [paxg.events.find((event) => event.signature === "FreezeAddress(address)")!.topicHash, log().topics[1]] };
    fixture.dependencies.loadLogs = async () => ({ logs: [freeze], timestamps: new Map([[110, NOW - 100]]) });
    fixture.dependencies.rpc = async (method, params) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_call") return `0x${"0".repeat(64)}`;
      return fixture.rpc(method, params);
    };
    await runConfigHistoryReplay({ ...fixture.options, configKey: paxg.configKey, apply: true }, fixture.dependencies);
    expect(fixture.sqlite.prepare("SELECT amount_native,amount_usd_at_event,amount_source FROM blacklist_events").get())
      .toEqual({ amount_native: null, amount_usd_at_event: null, amount_source: "unavailable" });
    expect(fixture.sqlite.prepare("SELECT amount_native,amount_usd,source,config_key FROM blacklist_current_balances").get())
      .toEqual({ amount_native: 0, amount_usd: null, source: "current_balance", config_key: paxg.configKey });
  });
  it("folds later lifecycle history outside the replay window before rebuilding balances", async () => {
    const fixture = setup();
    fixture.insert(log("destroy", 250, 2));
    await fixture.execute();
    expect(fixture.sqlite.prepare("SELECT amount_native,source FROM blacklist_current_balances").get())
      .toEqual({ amount_native: 12.5, source: "destroy_event" });
  });
  it.each([0, 42])("retains EURC freezes when only a current balance of %s is observed", async (currentBalance) => {
    const fixture = setup();
    const eurc = getBlacklistConfigsForSymbolAndChain("EURC", "ethereum")[0]!;
    fixture.sqlite.prepare("INSERT OR REPLACE INTO blacklist_sync_state(config_key,last_block,cursor_kind,cursor_value) VALUES (?,200,'evm_block',200)").run(eurc.configKey);
    const freeze = { ...log(), address: eurc.contractAddress,
      topics: [eurc.events.find((event) => event.eventType === "blacklist")!.topicHash, log().topics[1]] };
    fixture.dependencies.loadLogs = async () => ({ logs: [freeze], timestamps: new Map([[110, NOW - 100]]) });
    fixture.dependencies.rpc = async (method, params) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_call") return `0x${(BigInt(currentBalance) * 1_000_000n).toString(16).padStart(64, "0")}`;
      return fixture.rpc(method, params);
    };
    const result = await runConfigHistoryReplay({ ...fixture.options, configKey: eurc.configKey, apply: true }, fixture.dependencies);
    expect(result).toMatchObject({ insertedEventCount: 1, affectedBalanceCount: 1 });
    expect(fixture.sqlite.prepare("SELECT amount_native,suppression_reason FROM blacklist_events").get())
      .toEqual({ amount_native: null, suppression_reason: null });
    expect(ledgerRows(fixture.sqlite)).toMatchObject([{ amount_native: currentBalance, source: "current_balance" }]);
  });
  it("leaves a resolved balance untouched when the latest destroy has no proven amount", async () => {
    const fixture = setup();
    const destroy = fixture.insert(log("destroy", 250, 2));
    fixture.sqlite.prepare("UPDATE blacklist_events SET amount_native = NULL,amount_usd_at_event = NULL,amount_status = 'provider_failed' WHERE id = ?").run(destroy.id);
    const balance = observation({ stablecoin: config.stablecoin, chainId: config.chain.chainId,
      configKey: config.configKey, contractAddress: config.contractAddress, address: ADDRESS, amountNative: 99, amountUsd: 99 });
    fixture.sqlite.prepare(`INSERT INTO blacklist_current_balances (${BLACKLIST_CURRENT_BALANCE_COLUMNS}) VALUES (${Array.from({ length: 16 }, () => "?").join(",")})`)
      .run(...buildBlacklistCurrentBalanceValues(balance));
    const before = ledgerRows(fixture.sqlite);
    expect(await fixture.execute()).toMatchObject({ affectedBalanceCount: 0, insertedEventCount: 1 });
    expect(ledgerRows(fixture.sqlite)).toEqual(before);
  });
  it("requires pause/no active lease and a successful restore-point capture before writes", async () => {
    const fixture = setup();
    fixture.sqlite.prepare("DELETE FROM cache WHERE key = ?").run(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY);
    await expect(fixture.execute()).rejects.toThrow(/pause is not armed/);
    expect(fixture.imports).toEqual([]);
    fixture.sqlite.prepare("INSERT INTO cache(key,value,updated_at) VALUES (?,'pause',1)").run(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY);
    fixture.sqlite.prepare("INSERT INTO cron_leases(job,lease_until,lease_owner,heartbeat_at,updated_at) VALUES ('sync-blacklist',?,'test',?,?)").run(NOW + 60, NOW, NOW);
    await expect(fixture.execute()).rejects.toThrow(/lease is active/);
    expect(fixture.imports).toEqual([]);
    fixture.sqlite.exec("DELETE FROM cron_leases");
    fixture.dependencies.captureRestorePoint = vi.fn(() => { throw new Error("restore-point capture failed"); });
    await expect(fixture.execute()).rejects.toThrow(/restore-point capture failed/);
    expect(fixture.imports).toEqual([]);
  });
  it("captures after provider work and prints the restore point before import, without rejecting unrelated D1 writes", async () => {
    const fixture = setup();
    const messages: string[] = [];
    fixture.dependencies.log = (message) => { messages.push(message); };
    fixture.dependencies.captureRestorePoint = vi.fn(() => {
      expect(fixture.dependencies.loadLogs).toHaveBeenCalledOnce();
      expect(fixture.rpc).toHaveBeenCalledWith("eth_call", expect.any(Array));
      expect(fixture.imports).toEqual([]);
      // Busy, unrelated D1 writers are not a concurrency conflict for the scoped SQL guard.
      fixture.sqlite.exec("UPDATE cache SET updated_at = updated_at + 1 WHERE key = 'unrelated-cache'");
      return "restore-point-before-import";
    });
    const executeStatements = fixture.d1.executeStatements;
    fixture.d1.executeStatements = (statements, prefix) => {
      expect(messages.map((message) => JSON.parse(message))).toContainEqual({
        status: "restore-point-captured", configKey: config.configKey, timeTravelBookmark: "restore-point-before-import",
      });
      executeStatements(statements, prefix);
    };
    const result = await fixture.execute();
    expect(result).toMatchObject({ status: "verified", timeTravelBookmark: "restore-point-before-import" });
    expect(fixture.dependencies.captureRestorePoint).toHaveBeenCalledOnce();
  });
  it.each(["", "   "])("refuses a missing restore-point bookmark %j before writes", async (bookmark) => {
    const fixture = setup();
    fixture.dependencies.captureRestorePoint = vi.fn(() => bookmark);
    await expect(fixture.execute()).rejects.toThrow(/capture returned no bookmark/);
    expect(fixture.imports).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_action_audit").get()).toEqual({ n: 0 });
  });
  it("rolls back audit, events, balances and cache invalidation when a writer races preflight", async () => {
    const fixture = setup([log("destroy")]);
    fixture.dependencies.captureRestorePoint = vi.fn(() => {
      fixture.sqlite.prepare("UPDATE blacklist_sync_state SET attempt_generation = 1").run();
      return "captured-after-cursor-race";
    });
    const cachesBefore = derivedCacheRows(fixture.sqlite);
    await expect(fixture.execute()).rejects.toThrow(/CHECK constraint failed/);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_events").get()).toEqual({ n: 0 });
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_action_audit").get()).toEqual({ n: 0 });
    expect(ledgerRows(fixture.sqlite)).toEqual([]);
    expect(derivedCacheRows(fixture.sqlite)).toEqual(cachesBefore);
  });
  it("fails closed on parser coverage loss", async () => {
    const bad = log(); bad.data = "0xgarbage"; bad.topics[1] = "0xgarbage";
    const fixture = setup([bad]);
    await expect(fixture.execute()).rejects.toThrow(/complete log coverage/);
    expect(fixture.imports).toEqual([]);
  });
  it("enumerates every inclusive RPC page with current topic OR filters", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }), { status: 200 });
    }));
    const result = await fetchReplayLogs(config, { ...parseReplayArgs(args), chunkBlocks: 40 }, "https://rpc.example.invalid");
    expect(result.logs).toEqual([]);
    expect(requests.map((request) => request.params[0])).toEqual([
      { address: config.contractAddress, topics: [config.events.map((event) => event.topicHash)], fromBlock: "0x64", toBlock: "0x8b" },
      { address: config.contractAddress, topics: [config.events.map((event) => event.topicHash)], fromBlock: "0x8c", toBlock: "0xb3" },
      { address: config.contractAddress, topics: [config.events.map((event) => event.topicHash)], fromBlock: "0xb4", toBlock: "0xc8" },
    ]);
  });
  it("refuses incomplete RPC pages instead of publishing a partial replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "provider unavailable" } }), { status: 200 });
    }));
    await expect(fetchReplayLogs(config, parseReplayArgs(args), "https://rpc.example.invalid")).rejects.toThrow(/Incomplete RPC log interval/);
  });
});
