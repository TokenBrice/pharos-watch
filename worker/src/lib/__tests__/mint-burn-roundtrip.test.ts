import { describe, expect, it } from "vitest";
import { detectAtomicRoundtrips } from "../mint-burn-pipeline/roundtrip-detection";
import { makeMintBurnRow } from "../../test-helpers/__shared/fixtures";
import type { MintBurnRow } from "../mint-burn-pipeline/types";

const row = (direction: "mint" | "burn", amount = 100, overrides: Partial<MintBurnRow> = {}) => makeMintBurnRow({
  id: direction, direction, amount, amount_usd: amount, amount_raw: String(Math.round(amount * 1000)),
  tx_hash: "tx", ...overrides,
});

describe("detectAtomicRoundtrips", () => {
  it.each([
    [row("mint"), row("mint", 100, { id: "second" })],
    [row("burn")],
    [row("mint"), row("burn", 100, { tx_hash: "other" })],
    [row("mint"), row("burn", 100, { stablecoin_id: "other" })],
    [row("mint"), row("burn", 100, { chain_id: "arbitrum" })],
    [row("mint", 100, { tx_hash: "" }), row("burn", 100, { tx_hash: "" })],
    [row("mint"), row("burn", 100, { supply_proof_id: "pending-proof" })],
  ])("keeps one-sided or separately identified groups standard (%#)", (...rows) => {
    expect(detectAtomicRoundtrips(rows)).toBe(0);
    expect(rows.every((r) => r.flow_type === "standard")).toBe(true);
  });

  it("tags exact multi-row sums independently and preserves a signed residual", () => {
    const rows = [row("mint", 60), row("mint", 40, { id: "second" }), row("burn"),
      row("mint", 100, { tx_hash: "residual" }), row("burn", 100.4, { tx_hash: "residual" })];
    expect(detectAtomicRoundtrips(rows)).toBe(3);
    expect(rows.map((r) => r.flow_type)).toEqual(["atomic_roundtrip", "atomic_roundtrip", "atomic_roundtrip", "standard", "standard"]);
    expect(rows.filter((r) => r.flow_type === "standard")
      .reduce((net, r) => net + (r.direction === "mint" ? r.amount : -r.amount), 0)).toBeCloseTo(-0.4);
  });

  it("admits only resolved standard legs, leaving excluded legs out of the sum", () => {
    for (const exclusion of [{ flow_type: "bridge_transfer" }, { flow_type: "protocol_internal" },
      { burn_type: "review_required" }, { burn_type: "bridge_burn" }] as const) {
      const rows = [row("mint"), row("burn", 100, exclusion)];
      expect(detectAtomicRoundtrips(rows)).toBe(0);
      expect(rows[0].flow_type).toBe("standard");
      expect(rows[1]).toMatchObject(exclusion);
    }
    expect(detectAtomicRoundtrips([row("mint", 100, { burn_type: "review_required" }), row("burn")])).toBe(0);
    const excluded = row("mint", 999, { id: "bridge", flow_type: "bridge_transfer", amount_raw: null });
    expect(detectAtomicRoundtrips([row("mint"), row("burn"), excluded])).toBe(2);
    expect(excluded.flow_type).toBe("bridge_transfer");
  });

  it("compares raw integers beyond REAL precision and rejects missing or invalid amounts", () => {
    const mint = row("mint", 1e18, { amount_raw: "1000000000000000000000000000000000000" });
    const burn = row("burn", 1e18, { amount_raw: "1000000000000000000000000000000000001" });
    expect(detectAtomicRoundtrips([mint, burn])).toBe(0);
    burn.amount_raw = mint.amount_raw;
    expect(detectAtomicRoundtrips([mint, burn])).toBe(2);
    for (const amount_raw of [null, "", "1.2", "-1", "garbage"]) {
      expect(detectAtomicRoundtrips([row("mint"), row("burn", 100, { amount_raw })])).toBe(0);
    }
  });
});
