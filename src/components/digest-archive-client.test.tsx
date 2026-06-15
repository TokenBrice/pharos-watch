// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import { resolveLatestDailyDigestSlug } from "./digest-archive-client";

describe("resolveLatestDailyDigestSlug", () => {
  it("selects the latest daily digest even when a newer weekly recap is first", () => {
    expect(
      resolveLatestDailyDigestSlug([
        { generatedAt: Date.parse("2026-06-15T08:08:19Z") / 1000, digestType: "weekly" },
        { generatedAt: Date.parse("2026-06-15T08:08:16Z") / 1000, digestType: "daily" },
      ]),
    ).toBe("2026-06-15");
  });

  it("returns null when the archive contains only weekly recaps", () => {
    expect(
      resolveLatestDailyDigestSlug([
        { generatedAt: Date.parse("2026-06-15T08:08:19Z") / 1000, digestType: "weekly" },
      ]),
    ).toBeNull();
  });
});
