// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MethodologyHint } from "../methodology-hint";

describe("MethodologyHint desktop popover", () => {

  it("opens on click and exposes focusable methodology links", async () => {
    render(<MethodologyHint topic="pegScore" />);

    // Two triggers render (mobile Sheet + desktop Popover branch; visibility
    // is CSS-only, so jsdom sees both). The desktop one is the second.
    const triggers = screen.getAllByRole("button", { name: /explain/i });
    const desktopTrigger = triggers[triggers.length - 1];

    // Regression: this was a hover Tooltip whose links unmounted on trigger
    // blur, so they could never receive keyboard focus and click did nothing
    // on desktop.
    fireEvent.click(desktopTrigger);

    const methodologyLink = await screen.findByRole("link", { name: "View methodology" });
    methodologyLink.focus();
    expect(document.activeElement).toBe(methodologyLink);
  });
});
