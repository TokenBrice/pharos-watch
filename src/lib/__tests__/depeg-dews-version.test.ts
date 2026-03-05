import { describe, expect, it } from "vitest";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
  toDepegDewsMethodologyVersionLabel,
} from "@shared/lib/depeg-dews-version";

describe("depeg-dews-version", () => {
  it("keeps current version aligned with latest changelog entry", () => {
    expect(DEPEG_DEWS_METHODOLOGY_CHANGELOG[0]?.version).toBe(
      DEPEG_DEWS_METHODOLOGY_VERSION,
    );
    expect(toDepegDewsMethodologyVersionLabel(DEPEG_DEWS_METHODOLOGY_VERSION)).toBe(
      DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    );
  });

  it("resolves reconstructed version windows by timestamp", () => {
    expect(getDepegDewsMethodologyVersionAt(1771397625)).toBe("1.0");
    expect(getDepegDewsMethodologyVersionAt(1771407222)).toBe("1.1");
    expect(getDepegDewsMethodologyVersionAt(1771582000)).toBe("1.2");
    expect(getDepegDewsMethodologyVersionAt(1771587000)).toBe("2.0");
    expect(getDepegDewsMethodologyVersionAt(1771619000)).toBe("2.1");
    expect(getDepegDewsMethodologyVersionAt(1772019000)).toBe("3.0");
    expect(getDepegDewsMethodologyVersionAt(1772120000)).toBe("3.1");
    expect(getDepegDewsMethodologyVersionAt(1772189000)).toBe("3.2");
    expect(getDepegDewsMethodologyVersionAt(1772377300)).toBe("4.0");
    expect(getDepegDewsMethodologyVersionAt(1772379500)).toBe("4.1");
    expect(getDepegDewsMethodologyVersionAt(1772380000)).toBe("4.2");
    expect(getDepegDewsMethodologyVersionAt(1772397000)).toBe("4.3");
    expect(getDepegDewsMethodologyVersionAt(1772450000)).toBe("4.4");
  });

  it("returns current version for non-finite timestamps", () => {
    expect(getDepegDewsMethodologyVersionAt(Number.NaN)).toBe(
      DEPEG_DEWS_METHODOLOGY_VERSION,
    );
    expect(getDepegDewsMethodologyVersionAt(Number.POSITIVE_INFINITY)).toBe(
      DEPEG_DEWS_METHODOLOGY_VERSION,
    );
  });
});
