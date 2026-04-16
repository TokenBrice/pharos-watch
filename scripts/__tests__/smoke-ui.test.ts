import { describe, expect, it } from "vitest";

import { hasGaConfigInit } from "../smoke-ui.mjs";

describe("hasGaConfigInit", () => {
  it("accepts the single-quoted GA config emitted by older builds", () => {
    expect(hasGaConfigInit("gtag('config', 'G-6TS0KG8H04');", "G-6TS0KG8H04")).toBe(true);
  });

  it("accepts the double-quoted GA config emitted by JSON.stringify", () => {
    expect(hasGaConfigInit("gtag('config', \"G-6TS0KG8H04\");", "G-6TS0KG8H04")).toBe(true);
  });

  it("rejects a different GA measurement id", () => {
    expect(hasGaConfigInit("gtag('config', \"G-OTHER\");", "G-6TS0KG8H04")).toBe(false);
  });
});
