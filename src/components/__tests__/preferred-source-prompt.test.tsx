// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreferredSourcePrompt, PREFERRED_SOURCE_URL } from "../preferred-source-prompt";


describe("PreferredSourcePrompt", () => {
  // Google's source-preferences tool takes a bare host in `q`. A URL, a path,
  // or the wrong domain silently resolves to an empty picker rather than
  // erroring, so the failure mode is invisible in production.
  it("deeplinks to the bare canonical host, not a URL or subdirectory", () => {
    const url = new URL(PREFERRED_SOURCE_URL);

    expect(url.origin + url.pathname).toBe("https://www.google.com/preferences/source");
    expect(url.searchParams.get("q")).toBe("pharos.watch");
  });

  it("renders an external link a crawler and a reader can both follow", () => {
    render(<PreferredSourcePrompt />);

    const link = screen.getByRole("link", { name: /add pharos watch in google/i });
    expect(link.getAttribute("href")).toBe(PREFERRED_SOURCE_URL);
    // Opens in a new tab because the deeplink cannot return the reader to
    // their scroll position the way Google's scripted flow does.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
  });
});
