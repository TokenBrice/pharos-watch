// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const linkSpy = vi.hoisted(() => vi.fn());

vi.mock("next/link", () => ({
  default: (p: ComponentProps<"a">) => { linkSpy(p.href); return <a {...p} />; },
}));

vi.mock("@/components/intent-link", async () => ({ IntentLink: (await import("next/link")).default }));

import { DigestColophon } from "../digest-colophon";
import ComparePairPage from "@/app/compare/[slug]/page";
import { StablecoinDetailSeoContent } from "../stablecoin-detail/static-seo-content";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

afterEach(() => {
  cleanup();
  linkSpy.mockClear();
});

describe("RSS navigation", () => {
  it("renders the Digest colophon RSS entry as a native anchor, bypassing Next Link", () => {
    render(<DigestColophon />);
    const rss = screen.getByRole("link", { name: "RSS" });
    expect(rss.getAttribute("href")).toBe("/feed/digest.xml");
    expect(linkSpy).not.toHaveBeenCalledWith("/feed/digest.xml");
    expect(linkSpy).toHaveBeenCalledWith("/methodology/");
    expect(linkSpy).toHaveBeenCalledWith("/privacy/");
  });

  it.each(["comparison", "profile"])("%s keeps a native Digest RSS anchor", async (owner) => {
    render(owner === "comparison"
      ? await ComparePairPage({ params: Promise.resolve({ slug: "usdt-tether-vs-usdc-circle" }) })
      : <StablecoinDetailSeoContent coin={TRACKED_META_BY_ID.get("usdc-circle")!} />);
    expect(screen.getByRole("link", { name: "Digest RSS" }).getAttribute("href")).toBe("/feed/digest.xml");
    expect(linkSpy).not.toHaveBeenCalledWith("/feed/digest.xml");
  });
});
