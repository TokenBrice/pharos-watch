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
});
