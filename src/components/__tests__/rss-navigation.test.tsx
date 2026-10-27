// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const linkSpy = vi.hoisted(() => vi.fn());

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => {
      linkSpy(href);
      return React.createElement("a", { href, ...rest }, children);
    },
  };
});

const { DigestColophon } = await import("../digest-colophon");

afterEach(() => {
  cleanup();
  linkSpy.mockClear();
});

const RSS_OWNERS = [
  "src/components/digest-colophon.tsx",
  "src/app/compare/[slug]/page.tsx",
  "src/components/stablecoin-detail/static-seo-content.tsx",
];

describe("RSS navigation", () => {
  it("renders the Digest colophon RSS entry as a native anchor, bypassing Next Link", () => {
    render(<DigestColophon />);
    const rss = screen.getByRole("link", { name: "RSS" });
    expect(rss.getAttribute("href")).toBe("/feed/digest.xml");
    expect(linkSpy).not.toHaveBeenCalledWith("/feed/digest.xml");
    expect(linkSpy).toHaveBeenCalledWith("/methodology/");
    expect(linkSpy).toHaveBeenCalledWith("/privacy/");
  });

  it.each(RSS_OWNERS)("%s never routes /feed/digest.xml through Next Link", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/<(?:Link|IntentLink)\b[^>]*href=["']\/feed\/digest\.xml["']/);
  });

  it.each(RSS_OWNERS.slice(1))("%s keeps a native Digest RSS anchor", (path) => {
    expect(readFileSync(path, "utf8")).toMatch(/<a\s+href="\/feed\/digest\.xml"[^>]*>\s*<Rss[^>]*\/>\s*Digest RSS\s*<\/a>/);
  });
});
