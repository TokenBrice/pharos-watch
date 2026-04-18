import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";

vi.mock("@/hooks/api-hooks", () => ({
  useBluechipRatings: () => ({
    data: {
      "usdc-circle": {
        grade: "B",
        slug: "usdc",
      },
    },
  }),
}));

describe("BluechipHeaderBadge", () => {
  it("renders an explicit Bluechip label and outbound report link", () => {
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="usdc-circle" />);
    expect(html).toContain('href="https://bluechip.org/en/coins/usdc"');
    expect(html).toContain("Bluechip:");
    expect(html).toContain(">B<");
    expect(html).toContain('aria-label="Bluechip rating: B (via bluechip.org)"');
    expect(html).toContain('title="View the external Bluechip methodology"');
  });

  it("renders nothing when the stablecoin has no Bluechip rating", () => {
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="dai-makerdao" />);
    expect(html).toBe("");
  });
});
