// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";

const linkProps = vi.hoisted(() => vi.fn());

vi.mock("next/link", () => ({
  default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => {
    linkProps(props);
    const { prefetch: _prefetch, ...anchorProps } = props;
    return <a {...anchorProps}>{children}</a>;
  },
}));

import { HomeAltTrackerLink } from "@/components/home-alt-tracker-link";

describe("HomeAltTrackerLink", () => {
  it("preserves the destination, accessible name, prefetch setting, and icon", () => {
    render(<HomeAltTrackerLink href="/yield/" ariaLabel="Open yield tracker" prefetch={false} />);

    const link = screen.getByRole("link", { name: "Open yield tracker" });
    expect(link.getAttribute("href")).toBe("/yield/");
    expect(link.textContent).toContain("Tracker");
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(linkProps).toHaveBeenCalledWith(expect.objectContaining({ prefetch: false }));
  });
});
