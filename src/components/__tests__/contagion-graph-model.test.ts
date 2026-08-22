import { describe, expect, it } from "vitest";
import {
  compareDependencyTypes,
  DEPENDENCY_TYPE_FILTERS,
  DEPENDENCY_TYPE_ORDER,
  DEPENDENCY_TYPE_PRESENTATION,
  gradeColor,
} from "@/components/contagion-graph-model";
import { GRADE_RADAR_COLORS } from "@shared/lib/classification";
import type { ContagionEdgeRelationship } from "@/lib/contagion-layout";

describe("contagion graph dependency type presentation", () => {
  it("keeps graph filters in the shared dependency type order", () => {
    expect(DEPENDENCY_TYPE_FILTERS.map((filter) => filter.value)).toEqual(["all", ...DEPENDENCY_TYPE_ORDER]);
    expect(DEPENDENCY_TYPE_FILTERS.map((filter) => filter.label)).toEqual([
      "All",
      ...DEPENDENCY_TYPE_ORDER.map((type) => DEPENDENCY_TYPE_PRESENTATION[type].label),
    ]);
  });

  it("draws exactly the two structural relationships", () => {
    expect([...DEPENDENCY_TYPE_ORDER]).toEqual(["collateral", "wrapper"]);
    expect(DEPENDENCY_TYPE_ORDER.map((type) => DEPENDENCY_TYPE_PRESENTATION[type].label)).toEqual([
      "Collateral",
      "Wrapper",
    ]);
    for (const type of DEPENDENCY_TYPE_ORDER) {
      expect(DEPENDENCY_TYPE_PRESENTATION[type].description.length).toBeGreaterThan(0);
    }
  });

  it("keeps the V8 stroke encoding readers already know", () => {
    expect(DEPENDENCY_TYPE_PRESENTATION.collateral.dash).toBeUndefined();
    expect(DEPENDENCY_TYPE_PRESENTATION.wrapper.dash).toBeDefined();
    expect(DEPENDENCY_TYPE_PRESENTATION.collateral.color).not.toBe(DEPENDENCY_TYPE_PRESENTATION.wrapper.color);
  });

  it("shows a percentage only for a weighted collateral share", () => {
    expect(DEPENDENCY_TYPE_PRESENTATION.collateral.showWeight).toBe(true);
    expect(DEPENDENCY_TYPE_PRESENTATION.wrapper.showWeight).toBeFalsy();
  });

  it("sorts dependency types by the shared presentation order", () => {
    const types: ContagionEdgeRelationship[] = ["wrapper", "collateral"];
    expect(types.sort(compareDependencyTypes)).toEqual([...DEPENDENCY_TYPE_ORDER]);
  });

  it("colors nodes by the V9 grade band", () => {
    expect(gradeColor("A-")).toBe(GRADE_RADAR_COLORS.A);
    expect(gradeColor("C+")).toBe(GRADE_RADAR_COLORS.C);
    expect(gradeColor("NR")).toBe(GRADE_RADAR_COLORS.NR);
  });
});
