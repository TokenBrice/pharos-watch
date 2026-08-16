import { describe, expect, it } from "vitest";
import { buildStablecoinUrl as buildCompatibilityUrl } from "@/lib/urls";
import { buildStablecoinUrl } from "@shared/lib/urls";

describe("stablecoin URL compatibility entrypoint", () => {
  it("re-exports the runtime-neutral canonical builder", () => {
    expect(buildCompatibilityUrl).toBe(buildStablecoinUrl);
  });
});
