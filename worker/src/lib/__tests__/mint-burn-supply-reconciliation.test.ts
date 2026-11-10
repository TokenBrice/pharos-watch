import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { MintBurnSupplyReconciliationReceipt as Receipt } from "@shared/types/status";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../mint-burn-pipeline/scan-coverage";
import { reconcileMintBurnSupplyReceipt, readMintBurnSupplyReconciliation, runMintBurnSupplyReconciliation } from "../mint-burn-supply-reconciliation";
import { fetchEvmUint256AtBlock, fetchEvmBlockHeader } from "../evm-rpc";

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
async function setup() {
  const fixture = fixtures.open();
  const { db, sqlite } = fixture;
  sqlite.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)")
    .run("mint-burn:daily-reconciliation-state", JSON.stringify({ firstDay: start, cursor: 0 }), start);
  await upsertMintBurnSyncState(db, mintBurnConfigKey(config), 110, "monotonic-max", {
    configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: "ethereum",
    fromBlock: 99, toBlock: 110, fromTimestamp: start - 1, toTimestamp: start + 5 * day,
    finalizedBlock: 110, acceptedAt: start + 5 * day,
  });
  const input = { db, configs: [config], now: start + 2 * day + 3600, budget: { count: 0, limit: 200 },
    rpcEndpointsByChain: new Map(), heads: new Map([["ethereum", 110]]),
    priceContext: { priceObservations: new Map(), priceHistory: new Map() }, deadlineMs: Date.now() + 60_000 };
  const event = sqlite.prepare(`INSERT INTO mint_burn_events
    (id,stablecoin_id,symbol,chain_id,direction,amount,amount_raw,flow_type,tx_hash,block_number,timestamp,explorer_tx_url)
    VALUES (?,?,'USDS','ethereum','mint',1,'10','standard','tx',101,?,'url')`);
  for (let i = 0; i < 2; i++) event.run(String(i), config.stablecoinId, start + i * day + 100);
  return { ...fixture, input };
}
it("chains daily endpoints/windows, reuses supply, and never rebuilds pruned or immutable days", async () => {
  const { db, sqlite, input } = await setup();
  await runMintBurnSupplyReconciliation(input);
  await runMintBurnSupplyReconciliation(input);
  expect(fetchEvmUint256AtBlock).toHaveBeenCalledTimes(3);
  sqlite.exec("DELETE FROM mint_burn_events");
  await runMintBurnSupplyReconciliation({ ...input, now: start + 10 * day });
  expect(sqlite.prepare("SELECT count(*) AS n FROM mint_burn_supply_reconciliation WHERE day_ts < ?").get(start + 2 * day)?.n).toBe(2);
  // Fill seven continuous days from the two genuine fixtures to exercise exact window summation.
  const first = JSON.parse((sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation WHERE day_ts = ?").get(start) as { receipt_json: string }).receipt_json) as Receipt;
  for (let i = 2; i < 7; i++) {
    const r = { ...first, day: start + i * day, checkedAt: start + 7 * day,
      opening: { ...first.opening!, number: 100 + 2 * i, hash: hash(100 + 2 * i), timestamp: start + i * day - 1, supplyRaw: String(1000 + 10 * i) },
      closing: { ...first.closing!, number: 102 + 2 * i, hash: hash(102 + 2 * i), timestamp: start + (i + 1) * day - 1, supplyRaw: String(1010 + 10 * i) } };
    sqlite.prepare("INSERT OR REPLACE INTO mint_burn_supply_reconciliation VALUES (?,?,?,?,?)")
      .run(first.configKey, r.day, r.status, r.checkedAt, JSON.stringify(r));
  }
  const leg = (await readMintBurnSupplyReconciliation(db, [config], start + 8 * day)).get(first.configKey)!;
  expect(leg.windows.find((w) => w.days === 7)?.status).toBe("unavailable");
  const complete = (await readMintBurnSupplyReconciliation(db, [config], start + 7 * day)).get(first.configKey)!;
  expect(complete.windows.find((w) => w.days === 7)).toMatchObject({ status: "ok", supplyDeltaRaw: "70", residualRaw: "0",
    classes: { counted: { mintRaw: "70", burnRaw: "0", eventCount: 7 } } });
  const second = JSON.parse((sqlite.prepare("SELECT receipt_json FROM mint_burn_supply_reconciliation WHERE day_ts = ?").get(start + day) as { receipt_json: string }).receipt_json) as Receipt;
  const broken = { ...second, opening: { ...second.opening!, hash: hash(999) } };
  sqlite.prepare("UPDATE mint_burn_supply_reconciliation SET receipt_json = ? WHERE day_ts = ?").run(JSON.stringify(broken), start + day);
  const reread = (await readMintBurnSupplyReconciliation(db, [config], start + 7 * day)).get(first.configKey)!;
  expect(reread.windows.find((w) => w.days === 7)?.reason).toBe("daily-checkpoint-chain-broken");
  expect(reread.latest?.configFingerprint).toBeUndefined();
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
