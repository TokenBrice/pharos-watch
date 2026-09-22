import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildTronReplayRepairSql, validateTronReplayEvidence } from "../repair-tron-blacklist-amounts";

const token = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const address = "0xa546cb9b43af5a15f8ed6641fb77420af16094bd";
const base58 = "TR37Jf5Wkb2qfX1q92iQWQk42kr7ssvKGL";
const tx = "a".repeat(64), now = 1790103000000, cutoff = now - 20 * 60_000;
function fixture() {
  const anchorBlock = { blockID: "b".repeat(64), block_header: { raw_data: { number: 110, timestamp: cutoff } } };
  const initialUrl = `https://api.trongrid.io/v1/accounts/${base58}/transactions/trc20?min_timestamp=0&max_timestamp=${cutoff}&only_confirmed=true&contract_address=${token}&order_by=block_timestamp,asc&limit=200`;
  const row = (timestamp: number, value: string, id: string) => ({ transaction_id: id.repeat(64), token_info: { address: token, decimals: 6 }, block_timestamp: timestamp, from: "another-address", to: base58, type: "Transfer", value });
  return { version: 1, provider: "https://api.trongrid.io", capturedAtMs: now, entries: [{
    event: { id: `tron-${tx}-1`, address, base58, tx_hash: tx, block_number: 100, timestamp: (cutoff - 60000) / 1000, configKey: `tron-${token.toLowerCase()}` },
    anchor: { before: anchorBlock, after: structuredClone(anchorBlock), observedAtMs: cutoff + 1000, balance: { request: { owner_address: `41${address.slice(2)}`, contract_address: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c", function_selector: "balanceOf(address)", parameter: address.slice(2).padStart(64, "0"), visible: false }, response: { result: { result: true }, constant_result: [(25529200000n).toString(16).padStart(64, "0")] } } },
    freezeReceipt: { id: tx, blockNumber: 100, blockTimeStamp: cutoff - 60000, receipt: { result: "SUCCESS" }, log: [{ address: "a614f803b6fd780986a42c78ec9c7f77e6ded13c", topics: ["42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc", address.slice(2).padStart(64, "0")] }] },
    history: { initialUrl, complete: true, pages: [{ requestUrl: initialUrl, response: { success: true, data: [row(cutoff - 120000, "14591200000", "c"), row(cutoff - 30000, "10938000000", "d")], meta: { at: now, links: {} as { next?: string } } } }] },
  }] };
}

describe("Tron event-balance replay", () => {
  it("subtracts post-freeze inbound transfers instead of copying current balance", async () => {
    expect(await validateTronReplayEvidence(fixture(), now)).toMatchObject([{ rawAmount: "14591200000", amount: 14591.2 }]);
  });
  it.each([
    ["different block", (e: ReturnType<typeof fixture>) => { e.entries[0].anchor.after.blockID = "f".repeat(64); }],
    ["caller mismatch", (e: ReturnType<typeof fixture>) => { e.entries[0].anchor.balance.request.owner_address = "41" + "0".repeat(40); }],
    ["request token mismatch", (e: ReturnType<typeof fixture>) => { e.entries[0].anchor.balance.request.contract_address = "41" + "0".repeat(40); }],
    ["receipt mismatch", (e: ReturnType<typeof fixture>) => { e.entries[0].freezeReceipt.blockNumber++; }],
    ["balance mismatch", (e: ReturnType<typeof fixture>) => { e.entries[0].anchor.balance.response.constant_result[0] = "0".repeat(64); }],
    ["same timestamp", (e: ReturnType<typeof fixture>) => { e.entries[0].history.pages[0].response.data[0].block_timestamp = cutoff - 60000; }],
    ["missing page", (e: ReturnType<typeof fixture>) => { e.entries[0].history.pages[0].response.meta.links.next = "https://api.trongrid.io/next"; }],
    ["duplicate transfer", (e: ReturnType<typeof fixture>) => { e.entries[0].history.pages[0].response.data.splice(1, 0, structuredClone(e.entries[0].history.pages[0].response.data[0])); }],
    ["wrong token", (e: ReturnType<typeof fixture>) => { e.entries[0].history.pages[0].response.data[0].token_info.address = "bad"; }],
    ["unknown type", (e: ReturnType<typeof fixture>) => { e.entries[0].history.pages[0].response.data[0].type = "Issue"; }],
    ["indexing runway", (e: ReturnType<typeof fixture>) => { e.entries[0].history.pages[0].response.meta.at = cutoff + 1000; }],
  ] as const)("rejects %s", async (_name, mutate) => {
    const e = fixture(); mutate(e); await expect(validateTronReplayEvidence(e, now)).rejects.toThrow();
  });
  it("rejects stale evidence", async () => { await expect(validateTronReplayEvidence(fixture(), now + 16 * 60000)).rejects.toThrow("stale"); });
  it("guards the mutation and audit in the same transaction", async () => {
    const [repair] = await validateTronReplayEvidence(fixture(), now);
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE admin_action_audit(created_at,actor,action,target,result CHECK(result IN ('ok','error')),details_json,intent_key UNIQUE);
      CREATE TABLE blacklist_events(id PRIMARY KEY,chain_id,stablecoin,event_type,contract_address,address,tx_hash,block_number,timestamp,config_key,amount_native,amount_usd_at_event,amount,amount_status,suppression_reason,amount_source,amount_last_error_class,amount_last_provider,amount_last_attempted_at,amount_attempt_count DEFAULT 0,provenance_source,provenance_observed_at);
      CREATE TABLE cache(key PRIMARY KEY);`);
    const e = repair.event;
    db.prepare("INSERT INTO blacklist_events(id,chain_id,stablecoin,event_type,contract_address,address,tx_hash,block_number,timestamp,config_key,amount_status) VALUES (?,'tron','USDT','blacklist',?,?,?,?,?,?,'provider_failed')").run(e.id,token,e.address,e.tx_hash,e.block_number,e.timestamp,e.configKey);
    const sql = buildTronReplayRepairSql([repair], "e".repeat(64), "bookmark", now / 1000 + 120).join("\n");
    db.exec(`BEGIN;${sql}COMMIT;`);
    expect(db.prepare("SELECT amount_native,amount_source,provenance_observed_at,amount_last_attempted_at FROM blacklist_events").get()).toMatchObject({ amount_native: 14591.2, amount_source: "derived", provenance_observed_at: now / 1000, amount_last_attempted_at: now / 1000 + 120 });
    expect(() => db.exec(`BEGIN;${sql}COMMIT;`)).toThrow();
    db.exec("ROLLBACK;");
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_action_audit").get()).toMatchObject({ n: 1 });
    db.close();
  });
});
