import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteHeader } from "@/components/site-header";

const { healthMock, dexMock, stablecoinsMock } = vi.hoisted(() => ({
  healthMock: vi.fn(),
  dexMock: vi.fn(),
  stablecoinsMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useHealth: healthMock,
  useDexLiquidity: dexMock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: stablecoinsMock,
}));

function mockStable() {
  healthMock.mockReturnValue({ data: undefined });
  dexMock.mockReturnValue({ data: undefined });
  stablecoinsMock.mockReturnValue({ data: undefined });
}

describe("SiteHeader", () => {
  it("renders the new route-oriented tagline on tablet+desktop", () => {
    mockStable();
    const html = renderToStaticMarkup(
      <SiteHeader total={180} pegCount={19} chainCount={96} />,
    );
    expect(html).toContain(
      "Chart your route through the stablecoin market",
    );
    expect(html).toContain(
      "live peg, safety, liquidity, and dependency signals",
    );
  });

  it("does NOT render the old utilitarian tagline", () => {
    mockStable();
    const html = renderToStaticMarkup(
      <SiteHeader total={180} pegCount={19} chainCount={96} />,
    );
    expect(html).not.toContain(
      "Peg stress, liquidity, safety, and dependency signals for every tracked stablecoin.",
    );
  });

  it("exposes the tagline from md upward (not lg-only)", () => {
    mockStable();
    const html = renderToStaticMarkup(
      <SiteHeader total={180} pegCount={19} chainCount={96} />,
    );
    // Desktop/tablet block uses md:flex, not lg:flex
    expect(html).toMatch(/class="pharos-card-shell hidden md:flex/);
    // Mobile block uses md:hidden, not lg:hidden
    expect(html).toMatch(/class="pharos-card-shell[^"]*md:hidden/);
  });

  it("keeps stat pills and softens the unit labels to muted-foreground/70", () => {
    mockStable();
    const html = renderToStaticMarkup(
      <SiteHeader total={180} pegCount={19} chainCount={96} />,
    );
    expect(html).toContain("180");
    expect(html).toContain("coins");
    expect(html).toContain("text-muted-foreground/70");
  });
});
