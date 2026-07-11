import { describe, expect, it } from "vitest";
import { TELEGRAM_METRIC_SEMANTICS, pluralizeCount } from "../telegram-metrics";

describe("TELEGRAM_METRIC_SEMANTICS", () => {
  it("keeps distinct lifecycle concepts under distinct labels", () => {
    const labels = Object.values(TELEGRAM_METRIC_SEMANTICS).map((metric) => metric.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(TELEGRAM_METRIC_SEMANTICS.activeWatchers.label).not.toBe(
      TELEGRAM_METRIC_SEMANTICS.registeredChats.label,
    );
  });

  it("describes what each metric counts", () => {
    for (const metric of Object.values(TELEGRAM_METRIC_SEMANTICS)) {
      expect(metric.description.length).toBeGreaterThan(20);
    }
  });
});

describe("pluralizeCount", () => {
  it("selects the singular noun for exactly one", () => {
    expect(pluralizeCount(1, "preset")).toBe("preset");
    expect(pluralizeCount(1, "global alert family", "global alert families")).toBe("global alert family");
  });

  it("selects the plural noun otherwise", () => {
    expect(pluralizeCount(0, "preset")).toBe("presets");
    expect(pluralizeCount(2, "preset")).toBe("presets");
    expect(pluralizeCount(2, "global alert family", "global alert families")).toBe("global alert families");
  });
});
