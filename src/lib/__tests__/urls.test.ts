import { describe, it, expect } from "vitest";
import { buildStablecoinUrl } from "@/lib/urls";

describe("buildStablecoinUrl", () => {
  it("returns correct path for simple ID", () => {
    expect(buildStablecoinUrl("1")).toBe("/stablecoin/1/");
  });

  it("returns correct path for prefixed ID", () => {
    expect(buildStablecoinUrl("cg-ustb")).toBe("/stablecoin/cg-ustb/");
  });

  it("encodes special characters", () => {
    expect(buildStablecoinUrl("usdt-tether")).toBe("/stablecoin/usdt-tether/");
  });

  it("encodes spaces and unusual characters", () => {
    expect(buildStablecoinUrl("foo bar")).toBe("/stablecoin/foo%20bar/");
  });
});
