import { describe, expect, it } from "vitest";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { deriveSyncBlacklistStatus } from "../sync-support";

const threshold = Math.ceil(CONTRACT_CONFIGS.length / 2);

describe("sync blacklist status derivation", () => {
  it.each([
    ["healthy", 0, false, "ok"],
    ["provider-only failure", 1, false, "degraded"],
    ["runtime-only pressure", 0, true, "degraded"],
    ["exact error threshold", threshold, false, "degraded"],
    ["error precedence over runtime pressure", threshold + 1, true, "error"],
  ] as const)("classifies %s", (_name, errors, runtimePressure, expected) => {
    expect(deriveSyncBlacklistStatus(errors, runtimePressure)).toBe(expected);
  });
});
