import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  ACTIVE_STABLECOINS,
  FROZEN_IDS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  READABLE_IDS,
  READABLE_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../registry";
import { FROZEN_SNAPSHOTS_BY_ID } from "../frozen-snapshots";

describe("registry universes", () => {
  it("ACTIVE = status === 'active'", () => {
    expect(ACTIVE_STABLECOINS.every((c) => c.status === "active" || c.status === undefined)).toBe(true);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "pre-launch")).toBe(false);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "frozen")).toBe(false);
  });

  it("FROZEN = status === 'frozen'", () => {
    expect(FROZEN_STABLECOINS.every((c) => c.status === "frozen")).toBe(true);
  });

  it("READABLE = ACTIVE ∪ FROZEN (status !== 'pre-launch')", () => {
    expect(READABLE_STABLECOINS.length).toBe(ACTIVE_STABLECOINS.length + FROZEN_STABLECOINS.length);
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(READABLE_IDS.has(coin.id)).toBe(false);
    }
    for (const coin of [...ACTIVE_STABLECOINS, ...FROZEN_STABLECOINS]) {
      expect(READABLE_IDS.has(coin.id)).toBe(true);
    }
  });

  it("TRACKED = ACTIVE ∪ FROZEN ∪ PRE_LAUNCH (no overlap)", () => {
    expect(TRACKED_STABLECOINS.length).toBe(
      ACTIVE_STABLECOINS.length + FROZEN_STABLECOINS.length + PRE_LAUNCH_STABLECOINS.length,
    );
  });

  it("ACTIVE_IDS and FROZEN_IDS are disjoint", () => {
    for (const id of FROZEN_IDS) {
      expect(ACTIVE_IDS.has(id)).toBe(false);
    }
  });
});

describe("frozen invariants", () => {
  it("every FROZEN_STABLECOIN has a matching frozen-snapshots.json entry", () => {
    for (const coin of FROZEN_STABLECOINS) {
      expect(FROZEN_SNAPSHOTS_BY_ID.has(coin.id)).toBe(true);
    }
  });

  it("no orphan frozen-snapshots.json entries", () => {
    for (const id of FROZEN_SNAPSHOTS_BY_ID.keys()) {
      expect(FROZEN_IDS.has(id)).toBe(true);
    }
  });
});
