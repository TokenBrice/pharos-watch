import { describe, expect, it } from "vitest";
import { createBudget } from "../../../lib/evm-logs";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import type { BlacklistRow } from "../shared";
import { enrichRowBalances } from "../amount-recovery";
import { shouldSuppressAsMirrorZero } from "../post-fetch";

const a7a5Config: ContractEventConfig = {
  configKey: "ethereum-0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
  chain: {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm",
  },
  stablecoinId: "a7a5-old-vector",
  stablecoin: "A7A5",
  contractAddress: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
  decimals: 6,
  events: [],
};

function makeRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  return {
    id: "ethereum-0xtx-0x0",
    stablecoin: "A7A5",
    chain_id: "ethereum",
    chain_name: "Ethereum",
    event_type: "destroy",
    address: "0x1111111111111111111111111111111111111111",
    amount_native: 123,
    amount_usd_at_event: null,
    amount_source: "event",
    amount_status: "resolved",
    tx_hash: "0xtx",
    block_number: 22_080_100,
    timestamp: 1_776_300_000,
    methodology_version: "3.8",
    contract_address: a7a5Config.contractAddress,
    config_key: a7a5Config.configKey,
    event_signature: "DestroyedBlackFunds(address,uint256)",
    event_topic0: "0xtopic",
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    explorer_tx_url: "https://etherscan.io/tx/0xtx",
    explorer_address_url: "https://etherscan.io/address/0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

describe("EURC mirror-zero suppression (regression)", () => {
  it("suppresses a fresh EURC blacklist row when enrichment returns 0", () => {
    // Unit-test the pure helper since hitting the full backfill path is
    // already covered elsewhere.
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 0)).toBe(true);
    expect(shouldSuppressAsMirrorZero("EURC", "unblacklist", 0)).toBe(true);
  });

  it("leaves EURC destroy rows unsuppressed even at zero", () => {
    expect(shouldSuppressAsMirrorZero("EURC", "destroy", 0)).toBe(false);
  });

  it("leaves non-EURC rows unsuppressed at zero", () => {
    expect(shouldSuppressAsMirrorZero("USDC", "blacklist", 0)).toBe(false);
  });

  it("ignores non-zero amounts", () => {
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 123)).toBe(false);
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", null)).toBe(false);
  });
});

describe("enrichRowBalances", () => {
  it("fills USD value for emitted A7A5 amounts using the supplied asset price", async () => {
    const rows = [makeRow()];

    const counters = await enrichRowBalances(
      rows,
      a7a5Config,
      null,
      null,
      async (fn) => fn(),
      createBudget(5),
      Date.now() + 10_000,
      undefined,
      undefined,
      0.0125,
    );

    expect(counters).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0]?.amount_usd_at_event).toBe(1.5375);
  });
});
