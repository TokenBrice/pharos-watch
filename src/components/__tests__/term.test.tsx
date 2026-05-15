// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Term } from "@/components/term";
import { GLOSSARY } from "@/lib/glossary";

afterEach(() => cleanup());

describe("Term", () => {
  it("renders the wrapped label text", () => {
    render(<Term slug="cdp">CDP vaults</Term>);
    expect(screen.getByRole("button", { name: /Definition: CDP/i }).textContent).toBe("CDP vaults");
  });

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

  it("renders the children unchanged when the slug is unknown", () => {
    const { container } = render(<Term slug="not-a-real-slug">plain label</Term>);

    // Fallback path: <>{children}</> -> no button is rendered.
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("plain label");
  });
});
