import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { MECHANISM_EXPLAINER_TITLES } from "@/lib/mechanism-explainer-registry";

describe("mechanism explainer registry", () => {
  it("owns one non-empty title for every mechanism archetype", () => {
    expect(Object.keys(MECHANISM_EXPLAINER_TITLES).sort()).toEqual([...MECHANISM_ARCHETYPE_VALUES].sort());
    for (const title of Object.values(MECHANISM_EXPLAINER_TITLES)) {
      expect(title.trim()).not.toBe("");
    }
  });
});
