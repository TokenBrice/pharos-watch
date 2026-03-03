import { describe, expect, it } from "vitest";
import { STRICT_CONTRACT_PATHS_LIST } from "../strict-contract-paths";
import { ENDPOINT_ASSERTIONS, assertPathCoverage } from "../../../scripts/smoke-api.mjs";

describe("strict API path drift guards", () => {
  it("keeps strict contract path list unique", () => {
    expect(new Set(STRICT_CONTRACT_PATHS_LIST).size).toBe(STRICT_CONTRACT_PATHS_LIST.length);
  });

  it("keeps smoke endpoint assertions aligned with strict contract paths", () => {
    expect(() => assertPathCoverage(STRICT_CONTRACT_PATHS_LIST, ENDPOINT_ASSERTIONS)).not.toThrow();
  });
});
