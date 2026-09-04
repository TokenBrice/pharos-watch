import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DepegPage from "@/app/depeg/page";
import DepegArchivePage, { metadata as archiveMetadata } from "@/app/depeg/archive/page";
import { DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/dynamic", () => ({
  default: (_loader: unknown, options?: { loading?: () => ReactNode }) => {
    return function MockDynamicComponent() {
      return <>{options?.loading?.() ?? null}</>;
    };
  },
}));

function permanentEventHrefs(html: string): string[] {
  return Array.from(
    html.matchAll(/href="(\/depeg\/[^"]+\/)"/g),
    (match) => match[1]!,
  ).filter((href) => href !== "/depeg/archive/");
}

describe("DepegPage", () => {
  it("renders FAQ copy that matches the shipped peg-score and confirmation contract", () => {
    const html = renderToStaticMarkup(<DepegPage />);

    expect(html).toContain("fewer than 7 days of tracking history");
    expect(html).toContain("7 to 30 days are labeled Early score");
    expect(html).toContain("same-direction corroboration");
    expect(html).toContain("CoinGecko or DefiLlama");
    expect(html).toContain("Binance");
    expect(html).toContain("surface pre-price and live-market stress signals");
    expect(html).not.toContain("before it hits the price");
  });

  it("renders the Telegram setup CTA once in the header action area", () => {
    const html = renderToStaticMarkup(<DepegPage />);

    const matches = html.match(/Get instant Telegram alerts/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).toContain('href="/pharoswatchbot/#bot"');
    expect(html).toContain("Set up alerts");
  });

  it("renders only the latest calendar month as a server-side archive preview", () => {
    const html = renderToStaticMarkup(<DepegPage />);
    const newestMonth = new Date(DEPEG_EVENT_ENTRIES[0]!.startedAt * 1000)
      .toISOString()
      .slice(0, 7);
    const expectedHrefs = DEPEG_EVENT_ENTRIES
      .filter((event) =>
        new Date(event.startedAt * 1000).toISOString().startsWith(newestMonth))
      .map((event) => `/depeg/${event.slug}/`);

    expect(permanentEventHrefs(html)).toEqual(expectedHrefs);
    expect(expectedHrefs.length).toBeLessThan(DEPEG_EVENT_ENTRIES.length);
    expect(html).toContain('href="/depeg/archive/"');
  });
});

describe("DepegArchivePage", () => {
  it("server-renders every permanent event link exactly once", () => {
    const html = renderToStaticMarkup(<DepegArchivePage />);
    const hrefs = permanentEventHrefs(html);

    expect(hrefs).toEqual(
      DEPEG_EVENT_ENTRIES.map((event) => `/depeg/${event.slug}/`),
    );
  });

  it("publishes canonical archive metadata", () => {
    expect(archiveMetadata.alternates?.canonical).toBe("/depeg/archive/");
    expect(archiveMetadata.title).toBe("Depeg Event Archive");
    expect(archiveMetadata.description).toBeTruthy();
  });
});
