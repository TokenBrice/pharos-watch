import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { MECHANISM_ARCHETYPE_LABELS, MECHANISM_ARCHETYPE_ONE_LINERS } from "@shared/lib/classification";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import ArchetypeExplainerPage, {
  generateStaticParams,
  generateMetadata,
} from "@/app/learn/mechanisms/[archetype]/page";

describe("ArchetypeExplainerPage", () => {
  it("generateStaticParams returns exactly one entry per MechanismArchetype", () => {
    const params = generateStaticParams();
    expect(params).toHaveLength(MECHANISM_ARCHETYPE_VALUES.length);
    expect(new Set(params.map((entry) => entry.archetype))).toEqual(
      new Set(MECHANISM_ARCHETYPE_VALUES),
    );
  });

  for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
    it(`renders exactly one semantic <h1> for "${archetype}"`, async () => {
      const element = await ArchetypeExplainerPage({
        params: Promise.resolve({ archetype }),
      });
      const html = renderToStaticMarkup(element);
      const matches = html.match(/<h1\b/g) ?? [];
      expect(matches).toHaveLength(1);
    });
  }

  it("scopes reserve-free mint/burn to history while describing current collateralized algorithmic members", async () => {
    const content = ARCHETYPE_CONTENT.algorithmic;
    expect(content.howItWorks.every((step) => /historical pure mint\/burn/i.test(step.title))).toBe(true);
    expect(content.lead[0]).toMatch(/FPI.*FRAX.*USDD 2\.0.*collateralized.*ZSD.*reserve/i);
    expect(MECHANISM_ARCHETYPE_LABELS.algorithmic).not.toMatch(/unbacked/i);
    expect(MECHANISM_ARCHETYPE_ONE_LINERS.algorithmic).toMatch(/collateral.*reserve-backed.*historical/i);
    const metadata = await generateMetadata({ params: Promise.resolve({ archetype: "algorithmic" }) });
    expect(metadata.description).toMatch(/collateralized.*historical.*UST/i);
    expect(metadata.description).not.toMatch(/instead of full reserves/i);
    const html = renderToStaticMarkup(await ArchetypeExplainerPage({ params: Promise.resolve({ archetype: "algorithmic" }) }));
    expect(html).toMatch(/Diagram: historical UST-style pure mint\/burn/);
    for (const id of ["fpi-frax", "usdd-tron-dao-reserve", "zsd-zephyr-protocol"]) {
      const note = content.representativeCoins.find((coin) => coin.coinId === id)!.note;
      expect(html).toContain(renderToStaticMarkup(<p>{note}</p>).slice(3, -4));
    }
  });

  it("represents both Treasury price families in metadata and the rendered introduction", async () => {
    const content = ARCHETYPE_CONTENT.tbill;
    for (const text of [content.headline, content.subtitle, content.lead[0], MECHANISM_ARCHETYPE_ONE_LINERS.tbill]) {
      expect(text).toMatch(/NAV/i);
      expect(text).toMatch(/\$1/);
    }
    const metadata = await generateMetadata({ params: Promise.resolve({ archetype: "tbill" }) });
    expect(metadata.description).toMatch(/NAV.*\$1.*separate yield/i);
    const html = renderToStaticMarkup(await ArchetypeExplainerPage({ params: Promise.resolve({ archetype: "tbill" }) }));
    expect(html).toContain(content.headline);
    expect(html).toMatch(/Diagram: the NAV-accreting variant\. Par-stable \$1/);
    for (const id of ["benji-franklin-templeton", "buidl-blackrock", "usdy-ondo-finance", "ousg-ondo-finance"]) {
      const note = content.representativeCoins.find((coin) => coin.coinId === id)!.note;
      expect(html).toContain(renderToStaticMarkup(<p>{note}</p>).slice(3, -4));
    }
  });

  it("calls notFound() when handed an unknown archetype slug", async () => {
    notFoundMock.mockClear();
    await expect(
      ArchetypeExplainerPage({
        params: Promise.resolve({ archetype: "not-a-real-archetype" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});
