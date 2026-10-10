import { describe, expect, it } from "vitest";

import { getFreshnessSentinelConfigs, validateFreshnessSentinelPayload } from "../freshness-sentinels";

describe("freshness sentinel configuration", () => {
  it("validates the complete configuration when first accessed and memoizes it", () => {
    const configs = getFreshnessSentinelConfigs();

    expect(Object.keys(configs).sort()).toEqual(["dews", "dex-liquidity", "yield-data"]);
    expect(getFreshnessSentinelConfigs()).toBe(configs);
  });

  it.each([undefined, "", "   "])("rejects a missing or blank generation identity (%s)", (generationId) => {
    expect(validateFreshnessSentinelPayload({
      value: JSON.stringify({ updatedAt: 100, source: "compute-dews", publishStatus: "ok", generationId }),
      rowUpdatedAt: 100, expectedSource: "compute-dews", expectedGenerationId: "dews:100", now: 100,
    })).toMatchObject({ ok: false, reason: "invalid-payload" });
  });

  it("requires the sentinel to describe the served generation", () => {
    const input = {
      value: JSON.stringify({ updatedAt: 100, source: "compute-dews", publishStatus: "ok", generationId: "dews:100" }),
      rowUpdatedAt: 100, expectedSource: "compute-dews", now: 100,
    };
    expect(validateFreshnessSentinelPayload({ ...input, expectedGenerationId: null })).toMatchObject({ ok: false, reason: "missing-served-generation" });
    expect(validateFreshnessSentinelPayload({ ...input, expectedGenerationId: "dews:99" })).toMatchObject({ ok: false, reason: "generation-mismatch" });
    expect(validateFreshnessSentinelPayload({ ...input, expectedGenerationId: "dews:100" })).toMatchObject({ ok: true });
  });
});
