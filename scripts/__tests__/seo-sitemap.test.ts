import { describe, expect, it } from "vitest";

import { findDuplicateSitemapLocs, parseSitemapLocs } from "../lib/seo-sitemap.mjs";

describe("seo sitemap helpers", () => {
  it("extracts loc values as an ordered array by default", () => {
    expect(
      parseSitemapLocs(
        "<urlset><url><loc>https://pharos.watch/</loc></url><url><loc>https://pharos.watch/docs/</loc></url></urlset>",
      ),
    ).toEqual(["https://pharos.watch/", "https://pharos.watch/docs/"]);
  });

  it("can return loc values as a Set for membership checks", () => {
    const locs = parseSitemapLocs(
      "<urlset><url><loc>https://pharos.watch/</loc></url><url><loc>https://pharos.watch/</loc></url></urlset>",
      { asSet: true },
    );

    expect(locs).toEqual(new Set(["https://pharos.watch/"]));
  });

  it("reports each duplicated loc once", () => {
    expect(
      findDuplicateSitemapLocs([
        "https://pharos.watch/",
        "https://pharos.watch/digest/2026-07-18/",
        "https://pharos.watch/digest/2026-07-18/",
        "https://pharos.watch/digest/2026-07-18/",
      ]),
    ).toEqual(["https://pharos.watch/digest/2026-07-18/"]);
  });
});
