import { describe, expect, it } from "vitest";
import { resolveLiveReserveSourceAgeBudget } from "../live-reserve-freshness";

describe("live reserve source-age budgets", () => {
  it.each([
    [undefined, undefined, 300, "fetch-budget"],
    [120, undefined, 120, "scoring"],
    [undefined, 180, 180, "adapter"],
    [120, 180, 120, "scoring"],
    [180, 120, 120, "adapter"],
    [120, 120, 120, "scoring"],
    [0, 120, 0, "scoring"],
    [null, null, 300, "fetch-budget"],
  ] as const)("selects scoring %s / adapter %s without widening either cap", (scoring, adapter, budget, cap) => {
    expect(resolveLiveReserveSourceAgeBudget(scoring, adapter, 300)).toEqual({
      sourceAgeBudgetSec: budget, sourceAgeBudgetCap: cap,
    });
  });
});
