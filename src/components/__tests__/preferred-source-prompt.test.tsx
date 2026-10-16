// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreferredSourcePrompt, PREFERRED_SOURCE_URL } from "../preferred-source-prompt";


describe("PreferredSourcePrompt", () => {

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
