import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";

const entries = Object.entries(REDEMPTION_BACKSTOP_CONFIGS);

describe("redemption backstop config consistency", () => {
  it("every config ID exists in TRACKED_META_BY_ID", () => {
    const missing = entries
      .filter(([id]) => !TRACKED_META_BY_ID.has(id))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it("no duplicate config IDs", () => {
    const ids = Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it("offchain-issuer route requires issuer-api or manual access", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.routeFamily === "offchain-issuer" &&
          c.accessModel !== "issuer-api" &&
          c.accessModel !== "manual",
      )
      .map(([id, c]) => `${id}: offchain-issuer + ${c.accessModel}`);
    expect(violations).toEqual([]);
  });

  it("permissionless-onchain access excludes offchain-issuer route", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.accessModel === "permissionless-onchain" &&
          c.routeFamily === "offchain-issuer",
      )
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("atomic settlement excludes offchain-issuer route", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.settlementModel === "atomic" &&
          c.routeFamily === "offchain-issuer",
      )
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("queue-redeem route requires queued, days, or same-day settlement", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.routeFamily === "queue-redeem" &&
          c.settlementModel !== "queued" &&
          c.settlementModel !== "days" &&
          c.settlementModel !== "same-day",
      )
      .map(([id, c]) => `${id}: queue-redeem + ${c.settlementModel}`);
    expect(violations).toEqual([]);
  });

  it("algorithmic backing excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([id, c]) => {
        const meta = TRACKED_META_BY_ID.get(id);
        return (
          meta?.flags.backing === "algorithmic" &&
          c.routeFamily === "offchain-issuer"
        );
      })
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("delta-neutral protocols must not use supply-full capacity", () => {
    const DELTA_NEUTRAL_KEYWORDS = [
      "delta-neutral",
      "delta neutral",
      "funding rate arbitrage",
      "COIN-M perpetual short",
    ];

    const violations = entries
      .filter(([id, c]) => {
        const meta = TRACKED_META_BY_ID.get(id);
        if (!meta?.pegMechanism || c.capacityModel.kind !== "supply-full")
          return false;
        const peg = meta.pegMechanism.toLowerCase();
        return DELTA_NEUTRAL_KEYWORDS.some((kw) => peg.includes(kw.toLowerCase()));
      })
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });
});
