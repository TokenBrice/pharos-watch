import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  ACTIVE_STABLECOINS,
  DELISTED_IDS,
  DELISTED_STABLECOINS,
  FROZEN_IDS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  QUARANTINED_IDS,
  QUARANTINED_STABLECOINS,
  READABLE_IDS,
  READABLE_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../registry";
import {
  isActiveStablecoinMeta,
  isDelistedStablecoinMeta,
  isFrozenStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isQuarantinedStablecoinMeta,
  isReadableStablecoinMeta,
} from "../status";
import { FROZEN_SNAPSHOTS_BY_ID } from "../frozen-snapshots";

describe("registry universes", () => {
  it("ACTIVE = status === 'active'", () => {
    expect(ACTIVE_STABLECOINS.every(isActiveStablecoinMeta)).toBe(true);
    expect(ACTIVE_STABLECOINS.every((c) => c.status === "active" || c.status === undefined)).toBe(true);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "pre-launch")).toBe(false);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "quarantined")).toBe(false);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "delisted")).toBe(false);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "frozen")).toBe(false);
  });

  it("QUARANTINED and DELISTED retain readable records without entering active", () => {
    expect(QUARANTINED_STABLECOINS).toHaveLength(10);
    expect(DELISTED_STABLECOINS).toHaveLength(5);
    expect(QUARANTINED_STABLECOINS.every(isQuarantinedStablecoinMeta)).toBe(true);
    expect(DELISTED_STABLECOINS.every(isDelistedStablecoinMeta)).toBe(true);
    for (const coin of [...QUARANTINED_STABLECOINS, ...DELISTED_STABLECOINS]) {
      expect(ACTIVE_IDS.has(coin.id)).toBe(false);
      expect(READABLE_IDS.has(coin.id)).toBe(true);
    }
  });

  it("FROZEN = status === 'frozen'", () => {
    expect(FROZEN_STABLECOINS.every(isFrozenStablecoinMeta)).toBe(true);
    expect(FROZEN_STABLECOINS.every((c) => c.status === "frozen")).toBe(true);
  });

  it("READABLE = all post-launch lifecycle records", () => {
    expect(READABLE_STABLECOINS.every(isReadableStablecoinMeta)).toBe(true);
    expect(READABLE_STABLECOINS.length).toBe(
      ACTIVE_STABLECOINS.length
        + FROZEN_STABLECOINS.length
        + QUARANTINED_STABLECOINS.length
        + DELISTED_STABLECOINS.length,
    );
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(isPreLaunchStablecoinMeta(coin)).toBe(true);
      expect(READABLE_IDS.has(coin.id)).toBe(false);
    }
    for (const coin of [
      ...ACTIVE_STABLECOINS,
      ...FROZEN_STABLECOINS,
      ...QUARANTINED_STABLECOINS,
      ...DELISTED_STABLECOINS,
    ]) {
      expect(READABLE_IDS.has(coin.id)).toBe(true);
    }
  });

  it("TRACKED is the disjoint union of every lifecycle registry", () => {
    expect(TRACKED_STABLECOINS.length).toBe(
      ACTIVE_STABLECOINS.length
        + FROZEN_STABLECOINS.length
        + PRE_LAUNCH_STABLECOINS.length
        + QUARANTINED_STABLECOINS.length
        + DELISTED_STABLECOINS.length,
    );
  });

  it("ACTIVE_IDS and FROZEN_IDS are disjoint", () => {
    for (const id of FROZEN_IDS) {
      expect(ACTIVE_IDS.has(id)).toBe(false);
    }
    for (const id of [...QUARANTINED_IDS, ...DELISTED_IDS]) {
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
