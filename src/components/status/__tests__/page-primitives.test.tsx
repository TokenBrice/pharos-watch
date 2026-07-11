// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusSection } from "@/components/status/page-primitives";

afterEach(cleanup);

describe("StatusSection heading outline", () => {
  it("adds a nonvisual h2 group between a routed h1 and local h3 content", () => {
    render(
      <StatusSection id="actions" title="Actions" headingLevel="h1" variant="workspace">
        <h3>Action readiness</h3>
      </StatusSection>,
    );

    const h1 = screen.getByRole("heading", { level: 1, name: "Actions" });
    const h2 = screen.getByRole("heading", { level: 2, name: "Actions workspace content" });
    const h3 = screen.getByRole("heading", { level: 3, name: "Action readiness" });
    expect(h2.className).toContain("sr-only");
    expect(h1.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(h2.compareDocumentPosition(h3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not insert a redundant h2 beneath an existing h2 section title", () => {
    render(
      <StatusSection id="actions" title="Actions">
        <p>Section body</p>
      </StatusSection>,
    );

    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });
});
