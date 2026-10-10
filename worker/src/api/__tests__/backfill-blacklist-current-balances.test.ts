import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillBlacklistCurrentBalances } from "../backfill-blacklist-current-balances";
import { getBlacklistConfigsForSymbolAndChain } from "../../lib/blacklist-contracts";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

stubCryptoForAuth();
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("handleBackfillBlacklistCurrentBalances", () => {
  it("isolates contracts, excludes ambiguous legacy rows, and selects the latest address state", async () => {
    const { db, sqlite } = fixtures.open();
    const configs = getBlacklistConfigsForSymbolAndChain("USDT", "optimism");
    expect(configs).toHaveLength(2);
    const [first, second] = configs;
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url, config_key, contract_address, suppression_reason)
      VALUES (?, 'USDT', 'optimism', 'Optimism', ?, ?, 'tx', 1, ?, '', '', ?, ?, ?)`);
    insert.run("first", "blacklist", "0xAa", 100, first.configKey, first.contractAddress, null);
    insert.run("first-newer", "unblacklist", "0xaa", 200, first.configKey, first.contractAddress, null);
    insert.run("first-tie", "blacklist", "0xAA", 200, first.configKey, first.contractAddress, null);
    insert.run("second-contract", "blacklist", "0xbb", 100, null, second.contractAddress.toUpperCase(), null);
    insert.run("second-key", "blacklist", "0xcc", 100, second.configKey, null, null);
    insert.run("ambiguous-legacy", "blacklist", "0xdd", 100, null, null, null);
    insert.run("other-contract", "blacklist", "0xee", 100, null, "0xother", null);
    insert.run("suppressed", "blacklist", "0xff", 100, first.configKey, first.contractAddress, "reconciled");
    const request = makeApiRequest("/api/backfill-blacklist-current-balances?stablecoin=USDT&chainId=optimism&dryRun=true&limit=10", {
      method: "POST", adminKey: "secret-key",
    });
    const response = await handleBackfillBlacklistCurrentBalances({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    const body = await readJsonResponse<{ configs: Array<{ configKey: string; candidateCount: number; truncated: boolean }> }>(response, 200);
    expect(body.configs.map(({ configKey, candidateCount, truncated }) => ({ configKey, candidateCount, truncated }))).toEqual([
      { configKey: first.configKey, candidateCount: 1, truncated: false },
      { configKey: second.configKey, candidateCount: 2, truncated: false },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM blacklist_current_balances").get()).toEqual({ count: 0 });
  });

  it("retains legacy null-contract candidates when the chain has only one deployment", async () => {
    const { db, sqlite } = fixtures.open();
    const configs = getBlacklistConfigsForSymbolAndChain("USDT", "ethereum");
    expect(configs).toHaveLength(1);
    sqlite.exec(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url)
      VALUES ('legacy-ethereum', 'USDT', 'ethereum', 'Ethereum', 'blacklist', '0xaa', 'tx', 1, 100, '', '')`);
    const request = makeApiRequest("/api/backfill-blacklist-current-balances?stablecoin=USDT&chainId=ethereum&dryRun=true", {
      method: "POST", adminKey: "secret-key",
    });
    const response = await handleBackfillBlacklistCurrentBalances({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    const body = await readJsonResponse<{ configs: Array<{ configKey: string; candidateCount: number }> }>(response, 200);
    expect(body.configs.map(({ configKey, candidateCount }) => ({ configKey, candidateCount })))
      .toEqual([{ configKey: configs[0].configKey, candidateCount: 1 }]);
  });

  it.each(["ethereum", "tron"])("uses execution order rather than hashes for %s snapshots in dry-run and execution", async (chainId) => {
    const { db, sqlite } = fixtures.open();
    const [config] = getBlacklistConfigsForSymbolAndChain("USDT", chainId);
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url, config_key, contract_address,
       amount_native, amount_usd_at_event, transaction_index)
      VALUES (?, 'USDT', ?, ?, ?, ?, ?, 10, 100, '', '', ?, ?, ?, ?, ?)`);
    const hashHigh = "0x" + "f".repeat(64);
    const hashLow = "0x" + "a".repeat(64);
    for (const [address, known] of [["0xaa", true], ["0xbb", false]] as const) {
      insert.run(`${chainId}-${hashHigh}-0x2`, chainId, config.chain.chainName, "blacklist",
        address, hashHigh, config.configKey, config.contractAddress, null, null, known ? 0 : null);
      // Distinct array suffix also keeps both address fixtures separate.
      sqlite.prepare("UPDATE blacklist_events SET id = id || ? WHERE address = ? AND event_type = 'blacklist'")
        .run(address === "0xaa" ? "-0" : "-1", address);
      insert.run(`${chainId}-${hashLow}-0xa-${address === "0xaa" ? 0 : 1}`, chainId, config.chain.chainName, "destroy",
        address, hashLow, config.configKey, config.contractAddress, 42, 42, known ? 1 : null);
    }
    for (const dryRun of [true, false]) {
      const request = makeApiRequest(`/api/backfill-blacklist-current-balances?stablecoin=USDT&chainId=${chainId}&dryRun=${dryRun}`, {
        method: "POST", adminKey: "secret-key",
      });
      const response = await handleBackfillBlacklistCurrentBalances({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
      const body = await readJsonResponse<{ totals: { candidates: number; updated: number } }>(response, 200);
      expect(body.totals.candidates).toBe(chainId === "tron" ? 1 : 2);
      expect(body.totals.updated).toBe(dryRun ? 0 : chainId === "tron" ? 1 : 2);
    }
    const balances = sqlite.prepare("SELECT address, amount_native, source FROM blacklist_current_balances ORDER BY address").all();
    expect(balances).toEqual((chainId === "tron" ? ["0xaa"] : ["0xaa", "0xbb"])
      .map((address) => ({ address, amount_native: 42, source: "destroy_event" })));
  });
});
