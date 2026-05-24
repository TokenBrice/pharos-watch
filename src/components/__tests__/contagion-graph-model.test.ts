import { describe, expect, it } from "vitest";
import {
  compareDependencyTypes,
  DEPENDENCY_TYPE_FILTERS,
  DEPENDENCY_TYPE_ORDER,
  DEPENDENCY_TYPE_PRESENTATION,
} from "@/components/contagion-graph-model";

describe("contagion graph dependency type presentation", () => {
  it("keeps graph filters in the shared dependency type order", () => {
    expect(DEPENDENCY_TYPE_FILTERS.map((filter) => filter.value)).toEqual([
      "all",
      ...DEPENDENCY_TYPE_ORDER,
    ]);
    expect(DEPENDENCY_TYPE_FILTERS.map((filter) => filter.label)).toEqual([
      "All",
      ...DEPENDENCY_TYPE_ORDER.map((type) => DEPENDENCY_TYPE_PRESENTATION[type].label),
    ]);
  });

  it("sorts dependency types by the shared presentation order", () => {
    expect(["wrapper", "collateral", "mechanism"].sort(compareDependencyTypes)).toEqual([
      "collateral",
      "mechanism",
      "wrapper",
    ]);
  });
});
