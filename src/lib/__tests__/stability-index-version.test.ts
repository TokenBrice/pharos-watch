import { describe, expect, it } from "vitest";
import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_VERSION,
  PSI_METHODOLOGY_VERSION_LABEL,
  getPsiMethodologyVersionAt,
  toPsiMethodologyVersionLabel,
} from "../stability-index-version";

describe("stability-index-version", () => {
  it("keeps current version aligned with latest changelog entry", () => {
    expect(PSI_METHODOLOGY_CHANGELOG[0]?.version).toBe(PSI_METHODOLOGY_VERSION);
    expect(toPsiMethodologyVersionLabel(PSI_METHODOLOGY_VERSION)).toBe(PSI_METHODOLOGY_VERSION_LABEL);
  });

  it("resolves reconstructed version windows by timestamp", () => {
    expect(getPsiMethodologyVersionAt(1772012042)).toBe("1.0");
    expect(getPsiMethodologyVersionAt(1772039501)).toBe("1.1");
    expect(getPsiMethodologyVersionAt(1772059000)).toBe("1.2");
    expect(getPsiMethodologyVersionAt(1772068000)).toBe("1.3");
    expect(getPsiMethodologyVersionAt(1772070000)).toBe("2.0");
    expect(getPsiMethodologyVersionAt(1772300000)).toBe("2.1");
    expect(getPsiMethodologyVersionAt(1772380000)).toBe("3.0");
  });

  it("returns current version for non-finite timestamps", () => {
    expect(getPsiMethodologyVersionAt(Number.NaN)).toBe(PSI_METHODOLOGY_VERSION);
    expect(getPsiMethodologyVersionAt(Number.POSITIVE_INFINITY)).toBe(PSI_METHODOLOGY_VERSION);
  });
});
