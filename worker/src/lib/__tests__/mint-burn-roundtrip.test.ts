import { describe, expect, it } from "vitest";
import { detectAtomicRoundtrips, ROUNDTRIP_AMOUNT_TOLERANCE } from "../mint-burn-pipeline/roundtrip-detection";
import type { MintBurnRow } from "../mint-burn-pipeline/types";

// Drift guard: both `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` and
// `worker/src/api/reclassify-atomic-roundtrips.ts` hardcode the 0.005 literal
// inside their SQL HAVING clauses because SQL cannot interpolate TS constants.
// Any change to ROUNDTRIP_AMOUNT_TOLERANCE must update those SQL sites too.
// This CI-time assertion catches the drift before deploy; runtime module-load
// throws were rejected for blast radius.
describe("ROUNDTRIP_AMOUNT_TOLERANCE drift guard", () => {
  it("matches the hardcoded SQL literal in roundtrip-sweep.ts and reclassify-atomic-roundtrips.ts", () => {
    expect(ROUNDTRIP_AMOUNT_TOLERANCE).toBe(0.005);
  });
});

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

function mb(direction: "mint" | "burn", tx: string, amount: number, id = "x"): MintBurnRow {
  return {
    id: `${id}-${direction}`, stablecoin_id: "c", symbol: "C", chain_id: "ethereum",
    direction, amount, amount_usd: amount, price_used: 1, price_timestamp: 0,
    price_source: "test", burn_type: direction === "burn" ? "effective_burn" : null,
    burn_review_reason: null, flow_type: "standard", counterparty: null,
    tx_hash: tx, block_number: 1, timestamp: 1, explorer_tx_url: "",
  };
}

describe("detectAtomicRoundtrips — amount tolerance", () => {
  it("flags mint and burn that match within 0.5%", () => {
    const rows = [mb("mint", "0x1", 100), mb("burn", "0x1", 100.4)];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "atomic_roundtrip")).toBe(true);
  });

  it("does NOT flag mint 100 / burn 50 (net economic flow)", () => {
    const rows = [mb("mint", "0x2", 100), mb("burn", "0x2", 50)];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });

  it("does NOT flag mint 100 / burn 95 (5% mismatch exceeds tolerance)", () => {
    const rows = [mb("mint", "0x3", 100), mb("burn", "0x3", 95)];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });

  it("flags multi-row groups when totals match within tolerance", () => {
    const rows = [
      mb("mint", "0x4", 60, "a"), mb("mint", "0x4", 40, "b"),
      mb("burn", "0x4", 100, "c"),
    ];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "atomic_roundtrip")).toBe(true);
  });
});

describe("detectAtomicRoundtrips — empty tx_hash guard", () => {
  it("does not collide rows with missing tx_hash across different coins", () => {
    // Without the guard, both would share key "-coin-a" / "-coin-b"; with the guard they skip entirely.
    const rows = [
      { ...mb("mint", "", 100, "a"), tx_hash: "", stablecoin_id: "coin-a" } as MintBurnRow,
      { ...mb("burn", "", 100, "b"), tx_hash: "", stablecoin_id: "coin-a" } as MintBurnRow,
    ];
    detectAtomicRoundtrips(rows);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });
});
