// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Term } from "@/components/term";
import { GLOSSARY } from "@/lib/glossary";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";


describe("Term", () => {

  it("opens a popover on click revealing the glossary title and body", () => {
    render(<Term slug="cdp">CDP</Term>);
    const entry = GLOSSARY.cdp;

    // Closed popover -> no popover content in the document yet.
    expect(screen.queryByText(entry.term)).toBeNull();
    expect(screen.queryByText(entry.short)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Definition: CDP/i }));

    // After the click, the radix portal mounts the popover content.
    expect(screen.getByText(entry.term)).toBeTruthy();
    expect(screen.getByText(entry.short)).toBeTruthy();
  });

  it("dispatches methodology-context slugs through the methodology-hint surface", () => {
    render(<Term slug="dews">DEWS</Term>);
    const item = METHODOLOGY_CONTEXT.dews;

    // The methodology surface labels its trigger with `Explain ${title}`,
    // distinct from the glossary trigger's `Definition: ${term}` label. Both the
    // mobile (Sheet) and desktop (Tooltip) variants render in jsdom because the
    // responsive classes are inert without a layout engine, so we expect two
    // triggers with the methodology-shaped aria-label.
    const triggers = screen.getAllByRole("button", { name: /Explain DEWS/i });
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers[0].textContent).toBe("DEWS");

    // No glossary popover trigger should be present.
    expect(screen.queryByRole("button", { name: /Definition:/i })).toBeNull();

    // Opening the mobile Sheet surfaces the methodology summary text.
    fireEvent.click(triggers[0]);
    expect(screen.getAllByText(item.summary).length).toBeGreaterThan(0);
  });

});
