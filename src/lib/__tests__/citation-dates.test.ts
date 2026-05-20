import { describe, expect, it } from "vitest";
import {
  getCitationAccessedDateForPath,
  getCitationAccessedDateForUrl,
} from "@/lib/citation-dates";

describe("citation date resolution", () => {
  it("uses route-family sitemap dates for stablecoin detail citations", () => {
    expect(getCitationAccessedDateForPath("/stablecoin/usdc-circle/")).toBe(
      getCitationAccessedDateForPath("/stablecoins/"),
    );
  });

  it("uses route-family sitemap dates for depeg event citations", () => {
    expect(getCitationAccessedDateForUrl("https://pharos.watch/depeg/usdc-2023-03-11/")).toBe(
      getCitationAccessedDateForPath("/depeg/"),
    );
  });
});
