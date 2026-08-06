import { describe, expect, it } from "vitest";
import {
  compareDependencyTypes,
  DEPENDENCY_TYPE_FILTERS,
  DEPENDENCY_TYPE_ORDER,
  DEPENDENCY_TYPE_PRESENTATION,
  gradeColor,
} from "@/components/contagion-graph-model";
import { GRADE_RADAR_COLORS } from "@shared/lib/report-cards";
import type { ContagionEdgeMateriality } from "@/lib/contagion-layout";

describe("contagion graph dependency type presentation", () => {
  it("keeps graph filters in the shared dependency type order", () => {
    expect(DEPENDENCY_TYPE_FILTERS.map((filter) => filter.value)).toEqual(["all", ...DEPENDENCY_TYPE_ORDER]);
    expect(DEPENDENCY_TYPE_FILTERS.map((filter) => filter.label)).toEqual([
      "All",
      ...DEPENDENCY_TYPE_ORDER.map((type) => DEPENDENCY_TYPE_PRESENTATION[type].label),
    ]);
  });

  it("covers every canonical V9 materiality", () => {
    expect([...DEPENDENCY_TYPE_ORDER].sort()).toEqual([
      "basket-bounded-unknown",
      "basket-weighted",
      "serial",
      "serial-blocked",
    ]);
  });

  it("names relationships in reader-facing terms rather than engine terms", () => {
    expect(DEPENDENCY_TYPE_ORDER.map((type) => DEPENDENCY_TYPE_PRESENTATION[type].label)).toEqual([
      "Wrapper",
      "Collateral",
      "Wrapper · unscored",
      "Collateral · unscored",
    ]);
    for (const type of DEPENDENCY_TYPE_ORDER) {
      expect(DEPENDENCY_TYPE_PRESENTATION[type].description.length).toBeGreaterThan(0);
    }
  });

  it("keeps hue on the relationship and the broken stroke on the unscored upstream", () => {
    expect(DEPENDENCY_TYPE_PRESENTATION.serial.color).toBe(DEPENDENCY_TYPE_PRESENTATION["serial-blocked"].color);
    expect(DEPENDENCY_TYPE_PRESENTATION["basket-weighted"].color).toBe(
      DEPENDENCY_TYPE_PRESENTATION["basket-bounded-unknown"].color,
    );
    expect(DEPENDENCY_TYPE_PRESENTATION.serial.dash).toBeUndefined();
    expect(DEPENDENCY_TYPE_PRESENTATION["basket-weighted"].dash).toBeUndefined();
    expect(DEPENDENCY_TYPE_PRESENTATION["serial-blocked"].dash).toBeDefined();
    expect(DEPENDENCY_TYPE_PRESENTATION["basket-bounded-unknown"].dash).toBeDefined();
  });

  it("shows a percentage only for a weighted collateral share", () => {
    expect(DEPENDENCY_TYPE_PRESENTATION["basket-weighted"].showWeight).toBe(true);
    expect(DEPENDENCY_TYPE_PRESENTATION.serial.showWeight).toBeFalsy();
    expect(DEPENDENCY_TYPE_PRESENTATION["serial-blocked"].showWeight).toBeFalsy();
    expect(DEPENDENCY_TYPE_PRESENTATION["basket-bounded-unknown"].showWeight).toBeFalsy();
  });

  it("sorts dependency types by the shared presentation order", () => {
    const types: ContagionEdgeMateriality[] = [
      "basket-bounded-unknown",
      "serial-blocked",
      "serial",
      "basket-weighted",
    ];
    expect(types.sort(compareDependencyTypes)).toEqual([...DEPENDENCY_TYPE_ORDER]);
  });

  it("colors nodes by the V9 grade band", () => {
    expect(gradeColor("A-")).toBe(GRADE_RADAR_COLORS.A);
    expect(gradeColor("C+")).toBe(GRADE_RADAR_COLORS.C);
    expect(gradeColor("NR")).toBe(GRADE_RADAR_COLORS.NR);
  });
});
