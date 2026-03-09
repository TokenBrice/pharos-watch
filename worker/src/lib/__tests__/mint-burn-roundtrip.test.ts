import { describe, expect, it } from "vitest";
import { detectAtomicRoundtrips } from "../mint-burn-pipeline/roundtrip-detection";
import type { MintBurnRow } from "../mint-burn-pipeline/types";

function makeRow(overrides: Partial<MintBurnRow>): MintBurnRow {
  return {
    id: "ethereum-0xabc-0",
    stablecoin_id: "usdc-circle",
    symbol: "USDC",
    chain_id: "ethereum",
    direction: "mint",
    amount: 1_000_000,
    amount_usd: 1_000_000,
    price_used: 1,
    price_timestamp: 1_700_000_000,
    price_source: "price_cache",
    burn_type: null,
    burn_review_reason: null,
    flow_type: "standard",
    counterparty: "0x1234",
    tx_hash: "0xabc",
    block_number: 100,
    timestamp: 1_700_000_000,
    explorer_tx_url: "https://etherscan.io/tx/0xabc",
    ...overrides,
  };
}

describe("detectAtomicRoundtrips", () => {
  it("flags rows when same tx has both mint and burn for same coin", () => {
    const rows = [
      makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "mint" }),
      makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", direction: "burn" }),
    ];

    const flagged = detectAtomicRoundtrips(rows);

    expect(flagged).toBe(2);
    expect(rows[0].flow_type).toBe("atomic_roundtrip");
    expect(rows[1].flow_type).toBe("atomic_roundtrip");
  });

  it("does not flag when tx has only mints", () => {
    const rows = [
      makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "mint" }),
      makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", direction: "mint" }),
    ];

    const flagged = detectAtomicRoundtrips(rows);

    expect(flagged).toBe(0);
    expect(rows[0].flow_type).toBe("standard");
  });

  it("does not flag when tx has only burns", () => {
    const rows = [
      makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "burn" }),
    ];

    const flagged = detectAtomicRoundtrips(rows);

    expect(flagged).toBe(0);
  });

  it("handles multiple tx_hashes independently", () => {
    const rows = [
      makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "mint" }),
      makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", direction: "burn" }),
      makeRow({ id: "eth-0xdef-0", tx_hash: "0xdef", direction: "mint" }),
    ];

    const flagged = detectAtomicRoundtrips(rows);

    expect(flagged).toBe(2);
    expect(rows[2].flow_type).toBe("standard");
  });

  it("handles different stablecoins in same tx independently", () => {
    const rows = [
      makeRow({
        id: "eth-0xabc-0",
        tx_hash: "0xabc",
        stablecoin_id: "usdc-circle",
        direction: "mint",
      }),
      makeRow({
        id: "eth-0xabc-1",
        tx_hash: "0xabc",
        stablecoin_id: "usdt-tether",
        direction: "burn",
      }),
    ];

    const flagged = detectAtomicRoundtrips(rows);

    expect(flagged).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(detectAtomicRoundtrips([])).toBe(0);
  });
});
