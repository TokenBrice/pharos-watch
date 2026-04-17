import { describe, expect, it } from "vitest";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";

describe("Dual-index freeze family split", () => {
  it("FDUSD, EURI, U have only the 2 freeze events — not WLFI destroys", () => {
    const splitCoins = ["FDUSD", "EURI", "U"] as const;
    const wlfiDestroyTopics = new Set([
      "FrozenAccountDrained(address,address,uint256)",
      "FrozenFundsReallocated(address,address,address,uint256)",
    ]);
    for (const coin of splitCoins) {
      const cfgs = CONTRACT_CONFIGS.filter((c) => c.stablecoin === coin);
      expect(cfgs.length).toBeGreaterThan(0);
      for (const cfg of cfgs) {
        for (const def of cfg.events) {
          expect(wlfiDestroyTopics.has(def.signature)).toBe(false);
        }
        // Exactly 2 events (Freeze + Unfreeze):
        expect(cfg.events.length).toBe(2);
      }
    }
  });

  it("USD1 still carries the full WLFI freeze+destroy family (4 events)", () => {
    const cfgs = CONTRACT_CONFIGS.filter((c) => c.stablecoin === "USD1");
    expect(cfgs.length).toBeGreaterThan(0);
    for (const cfg of cfgs) {
      expect(cfg.events.length).toBe(4);
      expect(cfg.events.some((e) => e.signature.startsWith("FrozenAccountDrained"))).toBe(true);
    }
  });
});
