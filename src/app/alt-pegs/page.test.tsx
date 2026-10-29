import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PEG_HUB_PAGES } from "@/lib/peg-taxonomy";
import AltPegsPage from "./page";

vi.mock("next/dynamic", () => ({
  default: () =>
    function StubAltPegsClient() {
      return <div data-testid="alt-pegs-client">alt pegs client</div>;
    },
}));

// Next/link drops the canonical trailing slash and forwards `prefetch` to the DOM
// outside next.config's `trailingSlash: true`, which vitest does not load.
vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch: _prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    children?: ReactNode;
    className?: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const pegHubOverride = vi.hoisted(() => ({ pages: null as unknown[] | null }));

vi.mock("@/lib/peg-taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/peg-taxonomy")>();
  return {
    ...actual,
    get PEG_HUB_PAGES() {
      return (pegHubOverride.pages ?? actual.PEG_HUB_PAGES) as typeof actual.PEG_HUB_PAGES;
    },
  };
});

type Anchor = { href: string; text: string };

function renderDirectory(): { html: string; section: string; anchors: Anchor[] } {
  const html = renderToStaticMarkup(<AltPegsPage />);
  const match = html.match(/<section aria-labelledby="alt-peg-directories-heading"[\s\S]*?<\/section>/);
  if (!match) throw new Error("peg directory section is missing from the static HTML");
  const section = match[0];
  const anchors = [...section.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((anchor) => ({
    href: anchor[1],
    text: anchor[2].replace(/<[^>]+>/g, "").trim(),
  }));
  return { html, section, anchors };
}

describe("AltPegsPage static peg directories", () => {
  it("lists every non-USD peg hub once as static navigation before any client data", () => {
    const { html, section, anchors } = renderDirectory();
    const expected = PEG_HUB_PAGES.filter((page) => page.value !== "USD");

    expect(expected.length).toBeGreaterThan(0);
    expect(section).toContain(">Peg directories</h2>");
    expect(anchors.map((anchor) => anchor.href)).toEqual(expected.map((page) => page.href));
    expect(new Set(anchors.map((anchor) => anchor.href)).size).toBe(anchors.length);
    expect(anchors.map((anchor) => anchor.href)).not.toContain("/stablecoins/usd/");
    expect(anchors.map((anchor) => anchor.text)).toEqual(
      expected.map((page) => `${page.shortLabel} stablecoins${page.preLaunchOnly ? " · Upcoming" : ""}`),
    );

    const upcomingPages = expected.filter((page) => page.preLaunchOnly);
    expect(upcomingPages.length).toBeGreaterThan(0);
    for (const page of upcomingPages) {
      expect(anchors.find((anchor) => anchor.href === page.href)?.text).toContain("Upcoming");
    }
    for (const anchor of anchors.filter((candidate) => !upcomingPages.some((page) => page.href === candidate.href))) {
      expect(anchor.text).not.toContain("Upcoming");
    }

    // Registry navigation only: no counts, caps or other numeric market claims.
    expect(section.replace(/<[^>]+>/g, "")).not.toMatch(/\d/);

    // The directory survives below the dynamic client region, not inside it.
    expect(html.indexOf("alt-pegs-client")).toBeGreaterThan(-1);
    expect(html.indexOf("alt-pegs-client")).toBeLessThan(html.indexOf("alt-peg-directories-heading"));
  });

  it("omits the whole section when no peg hub projects", () => {
    pegHubOverride.pages = [];
    try {
      const html = renderToStaticMarkup(<AltPegsPage />);
      expect(html).not.toContain("alt-peg-directories-heading");
      expect(html).not.toContain("Peg directories");
    } finally {
      pegHubOverride.pages = null;
    }
  });
});
