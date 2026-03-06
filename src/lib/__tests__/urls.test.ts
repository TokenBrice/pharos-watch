import { describe, it, expect } from "vitest";
import { buildStablecoinUrl } from "@/lib/urls";

describe("buildStablecoinUrl", () => {
  it("returns correct path for simple ID", () => {
    expect(buildStablecoinUrl("usdt-tether")).toBe("/stablecoin/usdt-tether/");
  });

  it("returns correct path for prefixed ID", () => {
    expect(buildStablecoinUrl("ustb-superstate")).toBe("/stablecoin/ustb-superstate/");
  });

  it("encodes special characters", () => {
    expect(buildStablecoinUrl("usdt-tether")).toBe("/stablecoin/usdt-tether/");
  });

  it("encodes spaces and unusual characters", () => {
    expect(buildStablecoinUrl("foo bar")).toBe("/stablecoin/foo%20bar/");
  });
});
