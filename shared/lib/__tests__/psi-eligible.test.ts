import { describe, expect, it } from "vitest";
import { CLIENT_PSI_ELIGIBLE_META_BY_ID } from "../psi-eligible-client";
import {
  CORE_PSI_ELIGIBLE_IDS,
  CORE_PSI_ELIGIBLE_META_BY_ID,
  CORE_PSI_ELIGIBLE_STABLECOINS,
  PSI_ELIGIBLE_IDS,
  PSI_ELIGIBLE_META_BY_ID,
  PSI_ELIGIBLE_STABLECOINS,
} from "../psi-eligible";
import {
  ACTIVE_STABLE_VALUE_INVESTMENT_IDS,
  ACTIVE_VARIANT_IDS,
  CORE_AGGREGATE_ACTIVE_IDS,
  CORE_AGGREGATE_ACTIVE_STABLECOINS,
} from "../stablecoins/aggregate-registry";
import { ACTIVE_IDS, ACTIVE_STABLECOINS, FROZEN_IDS, PRE_LAUNCH_STABLECOINS } from "../stablecoins/registry";
import { SHADOW_IDS, SHADOW_STABLECOINS } from "../shadow-stablecoins";

describe("PSI eligibility", () => {
  it("keeps the broad monitoring universe at all active listings plus shadows", () => {
    expect(PSI_ELIGIBLE_IDS.size).toBe(ACTIVE_IDS.size + SHADOW_IDS.size);
    expect(PSI_ELIGIBLE_META_BY_ID.size).toBe(ACTIVE_IDS.size + SHADOW_IDS.size);
    expect(PSI_ELIGIBLE_STABLECOINS).toHaveLength(ACTIVE_STABLECOINS.length + SHADOW_STABLECOINS.length);

    for (const id of [...ACTIVE_IDS, ...SHADOW_IDS]) {
      expect(PSI_ELIGIBLE_IDS.has(id)).toBe(true);
      expect(PSI_ELIGIBLE_META_BY_ID.has(id)).toBe(true);
    }
  });

  it("keeps variants monitored but excludes them from the PSI monetary aggregate", () => {
    for (const id of [...ACTIVE_VARIANT_IDS, ...ACTIVE_STABLE_VALUE_INVESTMENT_IDS]) {
      expect(PSI_ELIGIBLE_IDS.has(id)).toBe(true);
      expect(PSI_ELIGIBLE_META_BY_ID.has(id)).toBe(true);
      expect(CORE_PSI_ELIGIBLE_IDS.has(id)).toBe(false);
      expect(CORE_PSI_ELIGIBLE_META_BY_ID.has(id)).toBe(false);
    }
  });

  it("defines the core PSI calculation universe separately", () => {
    expect(CORE_PSI_ELIGIBLE_IDS.size).toBe(CORE_AGGREGATE_ACTIVE_IDS.size + SHADOW_IDS.size);
    expect(CORE_PSI_ELIGIBLE_STABLECOINS).toHaveLength(
      CORE_AGGREGATE_ACTIVE_STABLECOINS.length + SHADOW_STABLECOINS.length,
    );
    for (const id of [...CORE_AGGREGATE_ACTIVE_IDS, ...SHADOW_IDS]) {
      expect(CORE_PSI_ELIGIBLE_IDS.has(id)).toBe(true);
    }
  });

  it("excludes pre-launch coins from PSI eligibility", () => {
    expect(PRE_LAUNCH_STABLECOINS.length).toBeGreaterThan(0);
    const ids = new Set(PSI_ELIGIBLE_STABLECOINS.map((s) => s.id));

    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(PSI_ELIGIBLE_IDS.has(coin.id)).toBe(false);
      expect(PSI_ELIGIBLE_META_BY_ID.has(coin.id)).toBe(false);
      expect(ids.has(coin.id)).toBe(false);
    }
  });

  it("excludes frozen coins from PSI_ELIGIBLE_IDS", () => {
    for (const id of FROZEN_IDS) {
      expect(PSI_ELIGIBLE_IDS.has(id)).toBe(false);
    }
  });

  it("excludes frozen coins from PSI_ELIGIBLE_META_BY_ID", () => {
    for (const id of FROZEN_IDS) {
      expect(PSI_ELIGIBLE_META_BY_ID.has(id)).toBe(false);
    }
  });

  it("excludes frozen coins from PSI_ELIGIBLE_STABLECOINS", () => {
    const ids = new Set(PSI_ELIGIBLE_STABLECOINS.map((s) => s.id));
    for (const id of FROZEN_IDS) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it("keeps the client PSI eligibility map in parity with the server map", () => {
    const allIds = new Set([...CLIENT_PSI_ELIGIBLE_META_BY_ID.keys(), ...PSI_ELIGIBLE_META_BY_ID.keys()]);
    const eligibilityFlags = [...allIds].sort().map((id) => ({
      id,
      clientEligible: CLIENT_PSI_ELIGIBLE_META_BY_ID.has(id),
      serverEligible: PSI_ELIGIBLE_META_BY_ID.has(id),
    }));
    const clientEntries = [...CLIENT_PSI_ELIGIBLE_META_BY_ID.entries()]
      .map(([id, meta]) => [id, { id: meta.id, name: meta.name, symbol: meta.symbol }] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const serverEntries = [...PSI_ELIGIBLE_META_BY_ID.entries()]
      .map(([id, meta]) => [id, { id: meta.id, name: meta.name, symbol: meta.symbol }] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect(eligibilityFlags.every((entry) => entry.clientEligible === entry.serverEligible)).toBe(true);
    expect(clientEntries).toEqual(serverEntries);
  });
});
