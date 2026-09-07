import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  DIGEST_STYLE_GATE_MODE_CACHE_KEYS,
  resolveDigestStyleGateMode,
} from "../digest-style-gate";

function modeTable(kind: "daily" | "weekly", value: string | null) {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [DIGEST_STYLE_GATE_MODE_CACHE_KEYS[kind]],
    rows: [],
    first: value == null ? null : { value, updated_at: 1_777_590_000 },
  };
}

describe("digest style gate mode resolution", () => {
  it("fails an invalid daily value to shadow without changing valid weekly enforce", async () => {
    const db = mockD1([
      modeTable("daily", "blocking"),
      modeTable("weekly", "enforce"),
    ], { requireMatch: true });

    await expect(resolveDigestStyleGateMode(db, "daily")).resolves.toBe("shadow");
    await expect(resolveDigestStyleGateMode(db, "weekly")).resolves.toBe("enforce");
  });

  it("fails a missing weekly value to shadow without changing valid daily enforce", async () => {
    const db = mockD1([
      modeTable("daily", "enforce"),
      modeTable("weekly", null),
    ], { requireMatch: true });

    await expect(resolveDigestStyleGateMode(db, "daily")).resolves.toBe("enforce");
    await expect(resolveDigestStyleGateMode(db, "weekly")).resolves.toBe("shadow");
  });
});
