import { describe, expect, it } from "vitest";
import { UNIVERSES } from "@/lib/universe-vocabulary";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { CORE_PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

describe("UNIVERSES", () => {
  it("counts the sets the code actually computes over", () => {
    expect(UNIVERSES.psi.count).toBe(CORE_PSI_ELIGIBLE_IDS.size);
    expect(UNIVERSES.core.count).toBe(CORE_AGGREGATE_ACTIVE_IDS.size);
    expect(UNIVERSES.active.count).toBe(ACTIVE_IDS.size);
  });
});
