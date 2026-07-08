import { describe, expect, it } from "vitest";
import { CLIENT_PSI_ELIGIBLE_META_BY_ID } from "../psi-eligible-client";
import { PSI_ELIGIBLE_IDS, PSI_ELIGIBLE_META_BY_ID, PSI_ELIGIBLE_STABLECOINS } from "../psi-eligible";
import { ACTIVE_IDS, ACTIVE_STABLECOINS, FROZEN_IDS, PRE_LAUNCH_STABLECOINS } from "../stablecoins/registry";
import { SHADOW_IDS, SHADOW_STABLECOINS } from "../shadow-stablecoins";

describe("PSI eligibility", () => {
  it("matches active tracked stablecoins plus PSI-only shadow assets", () => {
    expect(PSI_ELIGIBLE_IDS.size).toBe(ACTIVE_IDS.size + SHADOW_IDS.size);
    expect(PSI_ELIGIBLE_META_BY_ID.size).toBe(ACTIVE_IDS.size + SHADOW_IDS.size);
    expect(PSI_ELIGIBLE_STABLECOINS).toHaveLength(ACTIVE_STABLECOINS.length + SHADOW_STABLECOINS.length);

    for (const id of [...ACTIVE_IDS, ...SHADOW_IDS]) {
      expect(PSI_ELIGIBLE_IDS.has(id)).toBe(true);
      expect(PSI_ELIGIBLE_META_BY_ID.has(id)).toBe(true);
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
