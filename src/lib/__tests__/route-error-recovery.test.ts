import { describe, expect, it } from "vitest";
import { isHardReloadableRouteError } from "../route-error-recovery";

describe("isHardReloadableRouteError", () => {
  it("detects stale chunk and dynamic import failures", () => {
    expect(isHardReloadableRouteError(new Error("Loading chunk 123 failed"))).toBe(true);
    expect(isHardReloadableRouteError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isHardReloadableRouteError(new Error("Importing a module script failed"))).toBe(true);
  });

  it("ignores ordinary runtime errors", () => {
    expect(isHardReloadableRouteError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isHardReloadableRouteError(new Error("Something else broke"))).toBe(false);
    expect(isHardReloadableRouteError("Loading chunk 123 failed")).toBe(false);
  });
});
