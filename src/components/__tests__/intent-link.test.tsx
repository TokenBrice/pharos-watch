// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { IntentLink } from "../intent-link";
import { Footer } from "../footer";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean | null }) => (
    <a {...props} data-prefetch={prefetch === false ? "disabled" : "auto"} />
  ),
}));

afterEach(cleanup);

describe("IntentLink", () => {
  it("keeps a crawlable destination without speculative work until pointer intent", () => {
    render(<IntentLink href="/compare/">Compare</IntentLink>);
    const link = screen.getByRole("link", { name: "Compare" });
    expect(link.getAttribute("href")).toBe("/compare/");
    expect(link.getAttribute("data-prefetch")).toBe("disabled");
    fireEvent.mouseEnter(link);
    expect(link.getAttribute("data-prefetch")).toBe("auto");
  });

  it("enables prefetch on keyboard focus and preserves supplied handlers", () => {
    const onFocus = vi.fn();
    render(<IntentLink href="/learn/mechanisms/" onFocus={onFocus}>Mechanisms</IntentLink>);
    const link = screen.getByRole("link", { name: "Mechanisms" });
    fireEvent.focus(link);
    expect(onFocus).toHaveBeenCalledOnce();
    expect(link.getAttribute("data-prefetch")).toBe("auto");
  });

  it("never prefetches same-page section jumps, even after intent", () => {
    render(<IntentLink href="#report-card">Safety</IntentLink>);
    const link = screen.getByRole("link", { name: "Safety" });
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    expect(link.getAttribute("href")).toBe("#report-card");
    expect(link.getAttribute("data-prefetch")).toBe("disabled");
  });
});

describe("Footer route discovery", () => {
  it("keeps navigation order and disables all internal route prefetch", () => {
    render(<Footer />);
    const explore = within(screen.getByRole("navigation", { name: "Explore and reference" })).getAllByRole("link");
    expect(explore.map((link) => link.textContent)).toEqual([
      "Stablecoins", "Chains", "Mechanisms", "Case Studies", "Compare", "Depeg",
      "Digest", "Blog", "Changelog", "Methodology", "Coverage", "API",
    ]);
    const about = within(screen.getByRole("navigation", { name: "About" })).getAllByRole("link");
    expect(about.map((link) => link.textContent)).toEqual(["Independent", "Funding", "MIT", "Privacy Policy"]);
    for (const link of [...explore, ...about].filter((link) => link.getAttribute("href")?.startsWith("/"))) {
      expect(link.getAttribute("data-prefetch")).toBe("disabled");
    }
  });
});
