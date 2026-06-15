import { describe, expect, it } from "vitest";
import { REALTIME_FX_CURRENCY_TO_PEG, SECONDARY_FX_CURRENCY_TO_PEG } from "../fx-config";

describe("fx-config currency maps", () => {
  it("SECONDARY (lowercase keys) and REALTIME (uppercase keys) agree on the same currencies", () => {
    for (const [lowerKey, pegValue] of Object.entries(SECONDARY_FX_CURRENCY_TO_PEG)) {
      const upperKey = lowerKey.toUpperCase();
      expect(REALTIME_FX_CURRENCY_TO_PEG[upperKey], `missing ${upperKey} in REALTIME`).toBe(pegValue);
    }
  });

  it("SECONDARY keys are lowercase and REALTIME keys are uppercase", () => {
    for (const key of Object.keys(SECONDARY_FX_CURRENCY_TO_PEG)) {
      expect(key).toBe(key.toLowerCase());
    }
    for (const key of Object.keys(REALTIME_FX_CURRENCY_TO_PEG)) {
      expect(key).toBe(key.toUpperCase());
    }
  });
});
