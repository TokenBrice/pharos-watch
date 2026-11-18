import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { MintBurnSupplyReconciliationReceipt as Receipt } from "@shared/types/status";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { mintBurnConfigKey } from "../mint-burn-contract-identity";
import { upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../mint-burn-pipeline/scan-coverage";
import { reconcileMintBurnSupplyReceipt, readMintBurnSupplyReconciliation, runMintBurnSupplyReconciliation } from "../mint-burn-supply-reconciliation";
import { fetchEvmUint256AtBlock, fetchEvmBlockHeader, resolveClosestBlockAtOrBeforeTimestamp as closestBlock } from "../evm-rpc";

const day = 86_400;
const start = Date.parse("2026-11-07T00:00:00Z") / 1000;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
vi.mock("../evm-rpc", async (original) => ({ ...await original<object>(),
  resolveClosestBlockAtOrBeforeTimestamp: vi.fn(async (_chain, timestamp) => 100 + Math.floor((timestamp - (start - 1)) / (day / 2))),
  fetchEvmBlockHeader: vi.fn(async (_chain, number) => ({ number, hash: hash(number), timestamp: start - 1 + (number - 100) * day / 2 })),
  fetchEvmUint256AtBlock: vi.fn(async (_chain, _address, _selector, number) => 1_000n + BigInt((number - 100) * 5)),
}));
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
beforeEach(() => vi.clearAllMocks());
const config = MINT_BURN_CONFIGS.find((c) => c.stablecoinId === "usds-sky")!;
const row = (amount_raw: string | null, direction: "mint" | "burn" = "mint", burn_type: "review_required" | "effective_burn" | null = null) =>
  ({ amount_raw, direction, burn_type, flow_type: "standard" as const, burn_review_reason: burn_type === "review_required" ? "proof-missing" : null });
function base(delta = 10): Receipt {
  return { configKey: mintBurnConfigKey(config), chainId: "ethereum", stablecoinId: config.stablecoinId, address: config.contractAddress,
    decimals: 0, law: "transfer-supply", day: start, checkedAt: start + day, status: "unavailable", reason: "pending",
    opening: { number: 100, hash: hash(100), timestamp: start - 1, supplyRaw: "1000" },
    closing: { number: 102, hash: hash(102), timestamp: start + day - 1, supplyRaw: String(1000 + delta) },
    classes: null, reviewByReason: null, lawTermRaw: null, residualRaw: null, priceUsd: 1 };
}
it.each([
  [10, [row("10")], "ok", "0"],
  [-100, [row("100", "burn", "review_required")], "review-suppression", "0"],
  [-100, [row("100", "burn")], "review-suppression", "0"],
  [11, [row("10")], "unexplained-residual", "1"],
  [10, [row(null)], "unavailable", null],
  // A false zero-recipient Transfer explains at most the unresolved burn total, and only under that law.
  [-3, [row("5", "burn", "review_required")], "ok", "0", true, "2"],
  [-3, [row("5", "burn", "review_required")], "unexplained-residual", "2", false, "0"],
  [1, [row("5", "burn", "review_required")], "unexplained-residual", "6", true, "0"],
] as const)("reconciles delta %s exactly", (delta, rows, status, residual, falseZeroLaw = false, lawTerm = "0") => {
  const result = reconcileMintBurnSupplyReceipt(base(delta), rows, falseZeroLaw);
  expect([result.status, result.residualRaw]).toEqual([status, residual]);
  if (residual != null) expect(result.lawTermRaw).toBe(lawTerm);
  if (status === "review-suppression") expect(result.reviewByReason).not.toEqual({});
});
it("keeps an unevaluated USD criterion unavailable and counts excluded classes once", () => {
  expect(reconcileMintBurnSupplyReceipt({ ...base(-1), priceUsd: null }, [row("1", "burn", "review_required")]).reason)
    .toBe("review-materiality-price-unavailable");
  const rows = [row("10"), ...["bridge_transfer", "atomic_roundtrip", "protocol_internal"].map((flow_type) =>
    ({ ...row("2", "burn", "review_required"), flow_type: flow_type as "bridge_transfer" | "atomic_roundtrip" | "protocol_internal" }))];
  const result = reconcileMintBurnSupplyReceipt(base(4), rows);
  expect(result.status).toBe("ok");
  expect(Object.values(result.classes!).map((total) => total.eventCount)).toEqual([1, 0, 1, 1, 1]);
});
async function setup(target = config) {
  const fixture = fixtures.open();
  const { db, sqlite } = fixture;
  sqlite.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)")
    .run("mint-burn:daily-reconciliation-state", JSON.stringify({ firstDay: start, cursor: 0 }), start);
  await upsertMintBurnSyncState(db, mintBurnConfigKey(target), 110, "monotonic-max", {
    configKey: mintBurnConfigKey(target), configFingerprint: mintBurnScanFingerprint(target), chainId: target.chain.chainId,
    fromBlock: 99, toBlock: 110, fromTimestamp: start - 1, toTimestamp: start + 5 * day,
    finalizedBlock: 110, acceptedAt: start + 5 * day,
  });
  const input = { db, configs: [target], now: start + 2 * day + 3600, budget: { count: 0, limit: 200 },
    rpcEndpointsByChain: new Map(), heads: new Map([[target.chain.chainId, 110]]),
    priceContext: { priceObservations: new Map(), priceHistory: new Map() }, deadlineMs: Date.now() + 60_000 };
  const event = sqlite.prepare(`INSERT INTO mint_burn_events
    (id,stablecoin_id,symbol,chain_id,direction,amount,amount_raw,flow_type,tx_hash,block_number,timestamp,explorer_tx_url)
    VALUES (?,?,'USDS',?,'mint',1,'10','standard','tx',101,?,'url')`);
  for (let i = 0; i < 2; i++) event.run(String(i), target.stablecoinId, target.chain.chainId, start + i * day + 100);
  return { ...fixture, input };
}
it.each([config, MINT_BURN_CONFIGS.find((c) => c.stablecoinId === "usdai-usd-ai")!])("chains daily endpoints/windows on $chain.chainId, reuses supply, and never rebuilds pruned days", async (target) => {
  const { db, sqlite, input } = await setup(target);
  await runMintBurnSupplyReconciliation(input);
  await runMintBurnSupplyReconciliation(input);
  expect(fetchEvmUint256AtBlock).toHaveBeenCalledTimes(3);
  expect(vi.mocked(closestBlock).mock.calls[1][2].blockTimestampByNumber.has(100)).toBe(true);
  const originals = sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation ORDER BY day_ts").all();
  sqlite.exec("DELETE FROM mint_burn_events");
  await runMintBurnSupplyReconciliation({ ...input, now: start + 10 * day });
  expect(sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation WHERE day_ts < ? ORDER BY day_ts")
    .all(start + 2 * day)).toEqual(originals);
  // Fill seven continuous days from the two genuine fixtures to exercise exact window summation.
  const first = JSON.parse(String(sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation WHERE day_ts = ?").get(start)!.receipt_json)) as Receipt;
  for (let i = 2; i < 7; i++) {
    const r = { ...first, day: start + i * day, checkedAt: start + 7 * day,
      opening: { ...first.opening!, number: 100 + 2 * i, hash: hash(100 + 2 * i), timestamp: start + i * day - 1, supplyRaw: String(1000 + 10 * i) },
      closing: { ...first.closing!, number: 102 + 2 * i, hash: hash(102 + 2 * i), timestamp: start + (i + 1) * day - 1, supplyRaw: String(1010 + 10 * i) } };
    sqlite.prepare("INSERT OR REPLACE INTO mint_burn_supply_reconciliation VALUES (?,?,?,?,?)")
      .run(first.configKey, r.day, r.status, r.checkedAt, JSON.stringify(r));
  }
  const leg = (await readMintBurnSupplyReconciliation(db, [target], start + 8 * day)).get(first.configKey)!;
  expect(leg.windows.find((w) => w.days === 7)?.status).toBe("unavailable");
  const complete = (await readMintBurnSupplyReconciliation(db, [target], start + 7 * day)).get(first.configKey)!;
  expect(complete.windows.find((w) => w.days === 7)).toMatchObject({ status: "ok", supplyDeltaRaw: "70", residualRaw: "0",
    classes: { counted: { mintRaw: "70", burnRaw: "0", eventCount: 7 } } });
  const second = JSON.parse(String(sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation WHERE day_ts = ?").get(start + day)!.receipt_json)) as Receipt;
  const broken = { ...second, opening: { ...second.opening!, hash: hash(999) } };
  sqlite.prepare("UPDATE mint_burn_supply_reconciliation SET receipt_json = ? WHERE day_ts = ?").run(JSON.stringify(broken), start + day);
  const reread = (await readMintBurnSupplyReconciliation(db, [target], start + 7 * day)).get(first.configKey)!;
  expect(reread.windows.find((w) => w.days === 7)?.reason).toBe("daily-checkpoint-chain-broken");
  expect(reread.latest?.configFingerprint).toBeUndefined();
});
it.each([[false, null], [false, 1.01], [true, 1.01]] as const)("supersedes a retained day (old fingerprint: %s, prior price: %s)", async (oldFingerprint, priorPrice) => {
  const { db, sqlite, input } = await setup();
  input.now = start + day + 3600;
  const key = mintBurnConfigKey(config);
  const stored = () => JSON.parse(String(sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation").get()!.receipt_json));
  sqlite.exec(`UPDATE mint_burn_events SET amount_raw = '110' WHERE id = '0';
    INSERT INTO mint_burn_events (id, stablecoin_id, symbol, chain_id, direction, amount, amount_raw, flow_type,
      burn_type, burn_review_reason, tx_hash, block_number, timestamp, explorer_tx_url)
    SELECT 'burn', stablecoin_id, symbol, chain_id, 'burn', 1, '100', flow_type,
      'review_required', 'proof-missing', tx_hash, block_number, timestamp, explorer_tx_url FROM mint_burn_events WHERE id = '0'`);
  if (priorPrice != null) input.priceContext.priceHistory.set(config.stablecoinId,
    [{ snapshotDate: start + day, observedAt: input.now, price: priorPrice }]);
  await runMintBurnSupplyReconciliation(input);
  expect(stored()).toMatchObject({ status: "review-suppression", priceUsd: priorPrice });
  if (oldFingerprint) sqlite.exec(`UPDATE mint_burn_supply_reconciliation
    SET receipt_json = json_set(receipt_json, '$.configFingerprint', 'before-replay')`);
  const original = stored();
  const leg = () => readMintBurnSupplyReconciliation(db, [config], input.now).then((legs) => legs.get(key));
  expect((await leg())?.status).toBe(oldFingerprint ? "unavailable" : "review-suppression");

  sqlite.exec("UPDATE mint_burn_events SET burn_type = 'effective_burn', burn_review_reason = NULL WHERE id = 'burn'");
  sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?, 'ethereum', ?)").run(config.stablecoinId, start);
  input.now += 1800;
  await runMintBurnSupplyReconciliation(input);
  expect(stored()).toEqual(original);
  sqlite.exec("DELETE FROM mint_burn_dirty_hours");
  input.now += 1800;
  input.priceContext.priceHistory.set(config.stablecoinId, [{ snapshotDate: start + day, observedAt: input.now, price: 1 }]);
  await runMintBurnSupplyReconciliation(input);
  expect(stored()).toMatchObject({ status: "ok", checkedAt: input.now, supersededReceipts: [original],
    priceUsd: oldFingerprint ? 1 : priorPrice ?? 1, classes: { counted: { mintRaw: "110", burnRaw: "100", eventCount: 2 } } });
  expect(await leg()).toMatchObject({ status: "ok", activeFindings: [] });
  expect((await leg())?.latest).not.toHaveProperty("supersededReceipts");
  vi.clearAllMocks();
  const replacement = stored();
  await runMintBurnSupplyReconciliation({ ...input, now: input.now + 1800 });
  expect(stored()).toEqual(replacement);
  expect(fetchEvmBlockHeader).not.toHaveBeenCalled();
});
it("retains an unpriced residual until a repaired day with small review volume can be valued", async () => {
  const { db, sqlite, input } = await setup();
  input.now = start + day + 3600;
  const stored = () => JSON.parse(String(sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation").get()!.receipt_json));
  sqlite.exec("UPDATE mint_burn_events SET amount_raw = '20' WHERE id = '0'");
  await runMintBurnSupplyReconciliation(input);
  const original = stored();
  expect(original).toMatchObject({ status: "unexplained-residual", priceUsd: null });

  sqlite.exec(`UPDATE mint_burn_events SET amount_raw = '9' WHERE id = '0';
    INSERT INTO mint_burn_events (id,stablecoin_id,symbol,chain_id,direction,amount,amount_raw,flow_type,
      burn_type,burn_review_reason,tx_hash,block_number,timestamp,explorer_tx_url)
    SELECT 'review',stablecoin_id,symbol,chain_id,'mint',1,'1','standard','review_required','proof-missing',
      tx_hash,block_number,timestamp,explorer_tx_url FROM mint_burn_events WHERE id = '0'`);
  input.now += 1800;
  expect((await runMintBurnSupplyReconciliation(input)).processed).toBe(0);
  expect(stored()).toEqual(original);

  input.now += 1800;
  input.priceContext.priceHistory.set(config.stablecoinId, [{ snapshotDate: start + day, observedAt: input.now, price: 1 }]);
  expect((await runMintBurnSupplyReconciliation(input)).processed).toBe(1);
  expect(stored()).toMatchObject({ status: "ok", priceUsd: 1, residualRaw: "0", supersededReceipts: [original],
    classes: { review: { mintRaw: "1", eventCount: 1 } } });
  const leg = (await readMintBurnSupplyReconciliation(db, [config], input.now)).get(mintBurnConfigKey(config));
  expect(leg?.activeFindings).toEqual([]);
});
it("rechecks a settled day even when an earlier unavailable day keeps retrying", async () => {
  const { db, sqlite, input } = await setup();
  sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?, 'ethereum', ?)").run(config.stablecoinId, start);
  await runMintBurnSupplyReconciliation(input);
  await runMintBurnSupplyReconciliation(input);
  sqlite.exec("UPDATE mint_burn_events SET flow_type = 'protocol_internal' WHERE id = '1'");
  input.now += 6 * 3600 + 1;
  await runMintBurnSupplyReconciliation(input);
  input.now += 6 * 3600 + 1;
  await runMintBurnSupplyReconciliation(input);
  const results = await readMintBurnSupplyReconciliation(db, [config], input.now);
  expect(results.get(mintBurnConfigKey(config))?.latest).toMatchObject({
    day: start + day, status: "ok", classes: { protocol_internal: { mintRaw: "10", eventCount: 1 } },
  });
});
it.each(["ledger", "receipt"])("keeps the settled receipt when the %s races a replacement", async (race) => {
  const { sqlite, input } = await setup();
  input.now = start + day + 3600;
  const stored = () => String(sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation").get()!.receipt_json);
  await runMintBurnSupplyReconciliation(input);
  let expected = stored();
  sqlite.exec("UPDATE mint_burn_events SET flow_type = 'protocol_internal' WHERE id = '0'");
  vi.mocked(fetchEvmUint256AtBlock).mockImplementationOnce(async (_chain, _address, _selector, block) => {
    if (race === "ledger") sqlite.exec("UPDATE mint_burn_events SET amount_raw = '11' WHERE id = '0'");
    else {
      const checkedAt = input.now + 900;
      expected = JSON.stringify({ ...JSON.parse(expected), checkedAt });
      sqlite.prepare("UPDATE mint_burn_supply_reconciliation SET checked_at = ?, receipt_json = ?").run(checkedAt, expected);
    }
    return 1_000n + BigInt((Number(block) - 100) * 5);
  });
  const result = await runMintBurnSupplyReconciliation({ ...input, now: input.now + 1800 });
  expect(result.processed).toBe(0);
  expect(stored()).toBe(expected);
});
it.each(["dirty", "unsupported"])("keeps %s evidence unavailable without archive reads", async (kind) => {
  const { db, sqlite, input } = await setup();
  if (kind === "dirty") sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?,?,?)").run(config.stablecoinId, "ethereum", start);
  else input.configs = [{ ...config, contractAddress: `0x${"0".repeat(40)}` }];
  await runMintBurnSupplyReconciliation(input);
  const leg = [...(await readMintBurnSupplyReconciliation(db, input.configs, input.now)).values()][0]!;
  const stored = sqlite.prepare("SELECT status,receipt_json FROM mint_burn_supply_reconciliation ORDER BY day_ts LIMIT 1").get() as { status: string; receipt_json: string };
  expect(stored.status).toBe(kind === "dirty" ? "unavailable" : "unsupported-law");
  expect(JSON.parse(stored.receipt_json).classes).toBeNull();
  expect(leg.status).not.toBe("ok");
  expect(fetchEvmBlockHeader).not.toHaveBeenCalled();
});
