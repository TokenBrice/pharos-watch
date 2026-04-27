import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@/lib/urls";
import sitemap from "../sitemap";

describe("sitemap", () => {
  it("includes every frozen detail page (TRACKED source preserves indexability)", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));
    for (const id of FROZEN_IDS) {
      expect(urls.has(`${SITE_ORIGIN}${buildStablecoinUrl(id)}`)).toBe(true);
    }
  });
});
