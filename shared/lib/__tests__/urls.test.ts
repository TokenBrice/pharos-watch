import { describe, expect, it } from "vitest";
import { buildStablecoinUrl } from "@shared/lib/urls";

describe("buildStablecoinUrl", () => {
  it("encodes an id as one segment and keeps the canonical trailing slash", () => {
    expect(buildStablecoinUrl("usd/e coin")).toBe("/stablecoin/usd%2Fe%20coin/");
  });

  it("normalizes deep-link paths without disturbing queries or fragments", () => {
    expect(buildStablecoinUrl("usd/e coin", "/yield")).toBe("/stablecoin/usd%2Fe%20coin/yield/");
    expect(buildStablecoinUrl("usd/e coin", "yield/#warning-signals")).toBe(
      "/stablecoin/usd%2Fe%20coin/yield/#warning-signals",
    );
    expect(buildStablecoinUrl("usd/e coin", "?tab=history#point")).toBe(
      "/stablecoin/usd%2Fe%20coin/?tab=history#point",
    );
  });
});
