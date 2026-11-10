import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  ACTIVE_STABLECOINS,
  DELISTED_STABLECOINS,
  FROZEN_IDS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  QUARANTINED_STABLECOINS,
  READABLE_IDS,
  READABLE_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../registry";
import {
  isDelistedStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isQuarantinedStablecoinMeta,
  isReadableStablecoinMeta,
} from "../status";
import { FROZEN_SNAPSHOTS_BY_ID } from "../frozen-snapshots";
import { getListingClass } from "../listing-governance";

describe("registry universes", () => {
  it("QUARANTINED and DELISTED retain readable records without entering active", () => {
    expect(QUARANTINED_STABLECOINS.every(isQuarantinedStablecoinMeta)).toBe(true);
    expect(DELISTED_STABLECOINS.every(isDelistedStablecoinMeta)).toBe(true);
    const isQuarantinedId = (id: string): boolean => QUARANTINED_STABLECOINS.some((coin) => coin.id === id);
    for (const coin of [...QUARANTINED_STABLECOINS, ...DELISTED_STABLECOINS]) {
      expect(ACTIVE_IDS.has(coin.id)).toBe(false);
      expect(READABLE_IDS.has(coin.id)).toBe(true);
      // Every hold carries its own dated, reasoned review; the reversible
      // quarantine additionally pins a manual follow-up date.
      expect(coin.listingStatusReview?.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(coin.listingStatusReview?.reason.trim()).not.toBe("");
      if (isQuarantinedStablecoinMeta(coin)) {
        expect(coin.listingStatusReview?.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    // The 2026-09-24 coverage review's runtime holds must stay out of the active
    // publication contract while remaining readable detail records.
    for (const id of ["hlusd-hela", "vusd-virtue", "luausd-lumi-finance"]) {
      expect(isQuarantinedId(id)).toBe(true);
      expect(ACTIVE_IDS.has(id)).toBe(false);
      expect(READABLE_IDS.has(id)).toBe(true);
    }
  });

  it("preserves VCRED as a readable scope delisting, not a frozen or live instrument", () => {
    const coin = DELISTED_STABLECOINS.find((entry) => entry.id === "vcred-vcred");
    expect(coin).toMatchObject({
      status: "delisted",
      listingStatusReview: {
        changedAt: "2026-10-22",
        source: {
          url: "https://explorer.hemi.xyz/api/v2/smart-contracts/0x71881974e96152643c74a8e0214b877cfb2a0aa1",
        },
      },
      mechanismArchetypeReview: { disposition: "unresolved", reviewedAt: "2026-10-02" },
    });
    expect(getListingClass("vcred-vcred")).toBe("excluded");
    expect(ACTIVE_IDS.has("vcred-vcred")).toBe(false);
    expect(READABLE_IDS.has("vcred-vcred")).toBe(true);
    expect(FROZEN_IDS.has("vcred-vcred")).toBe(false);
    expect(FROZEN_SNAPSHOTS_BY_ID.has("vcred-vcred")).toBe(false);
    expect(coin?.liveReservesConfig).toBeUndefined();
    expect(coin?.frozenAt).toBeUndefined();
    expect(coin?.obituary).toBeUndefined();
  });

  it.each([
    ["usdkg-gold-dollar", "2026-10-19", "regulatory", "2026-10-05"],
    ["fxd-fathom", "2026-11-08", "abandoned", "2026-08-26"],
  ])("preserves %s as a readable frozen identity, not an active producer", (id, frozenAt, causeOfDeath, deathDate) => {
    expect(FROZEN_IDS.has(id)).toBe(true);
    expect(READABLE_IDS.has(id)).toBe(true);
    expect(ACTIVE_IDS.has(id)).toBe(false);
    expect(FROZEN_SNAPSHOTS_BY_ID.has(id)).toBe(true);
    expect(FROZEN_STABLECOINS.find((coin) => coin.id === id)).toMatchObject({
      frozenAt, obituary: { causeOfDeath, deathDate },
    });
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
    const partitions = [
      ACTIVE_STABLECOINS, FROZEN_STABLECOINS, PRE_LAUNCH_STABLECOINS,
      QUARANTINED_STABLECOINS, DELISTED_STABLECOINS,
    ].map((coins) => coins.map((coin) => coin.id));
    const ids = partitions.flat();
    expect(ids.toSorted()).toEqual(TRACKED_STABLECOINS.map((coin) => coin.id).toSorted());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < partitions.length; i++) {
      for (const other of partitions.slice(i + 1)) {
        expect(partitions[i].filter((id) => other.includes(id))).toEqual([]);
      }
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
