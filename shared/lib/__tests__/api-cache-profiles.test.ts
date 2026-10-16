import { describe, expect, it } from "vitest";
import {
  buildPerCoinCacheControl,
} from "../api-cache-profiles";

describe("API cache profiles", () => {

  it("builds bounded per-coin cache headers", () => {
    expect(buildPerCoinCacheControl(300)).toBe("public, s-maxage=300, max-age=10");
    expect(buildPerCoinCacheControl(12.9)).toBe("public, s-maxage=12, max-age=10");
    expect(buildPerCoinCacheControl(-10)).toBe("public, s-maxage=0, max-age=10");
  });
});
