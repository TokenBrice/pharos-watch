import { describe, expect, it } from "vitest";
import { deriveSyncBlacklistStatus } from "../sync-support";

describe("sync blacklist status derivation", () => {
  it("degrades any runtime pressure or provider error", () => {
    expect(
      deriveSyncBlacklistStatus(1, true, {
        contractsSkipped: 8,
        totalConfigs: 71,
        incompleteRuntimeConfigs: 0,
        subrequestBudgetHit: false,
      }),
    ).toBe("degraded");
  });

  it("keeps material runtime pressure degraded", () => {
    expect(
      deriveSyncBlacklistStatus(0, true, {
        contractsSkipped: 11,
        totalConfigs: 71,
        incompleteRuntimeConfigs: 0,
        subrequestBudgetHit: false,
      }),
    ).toBe("degraded");
    expect(
      deriveSyncBlacklistStatus(0, true, {
        contractsSkipped: 0,
        totalConfigs: 71,
        incompleteRuntimeConfigs: 1,
        subrequestBudgetHit: false,
      }),
    ).toBe("degraded");
    expect(
      deriveSyncBlacklistStatus(0, true, {
        contractsSkipped: 0,
        totalConfigs: 71,
        incompleteRuntimeConfigs: 0,
        subrequestBudgetHit: true,
      }),
    ).toBe("degraded");
  });
});
