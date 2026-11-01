import { describe, expect, it, vi } from "vitest";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "font-test", variable: "--font-test" }),
}));

import { metadata } from "@/app/cemetery/page";

const stats = buildCemeteryStats(CEMETERY_ENTRIES);
const title = String(metadata.title);
const description = String(metadata.description);

describe("Cemetery route metadata", () => {
  it("names the documented archive instead of claiming a complete failure census", () => {
    expect(title).toContain(`${stats.total} Documented`);
    expect(description).toContain(`${stats.total} failed or discontinued stablecoins documented by Pharos`);
    expect(description).toContain(`since ${stats.firstYear}`);
    expect(description.startsWith(`${stats.total} dead stablecoins since`)).toBe(false);
  });

  it("keeps the search-snippet budgets", () => {
    expect(description.length).toBeGreaterThanOrEqual(110);
    expect(description.length).toBeLessThanOrEqual(180);
    expect(`${title} | Pharos`.length).toBeLessThanOrEqual(70);
  });
});
