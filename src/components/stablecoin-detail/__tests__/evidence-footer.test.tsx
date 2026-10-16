// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { EvidenceFooter } from "../evidence-footer";

const SOURCES = [
  { label: "Issuer attestation", url: "https://example.com/attestation" },
  { label: "Custody agreement", url: "https://example.com/custody" },
];

/** The summary's accessible text: rendered text minus `aria-hidden` subtrees. */
function accessibleText(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return Array.from(node.childNodes).map(accessibleText).join("");
}

describe("EvidenceFooter", () => {
  it("folds review notes and sources into one closed disclosure, notes first", () => {
    const { container } = render(
      <EvidenceFooter sources={SOURCES} notes={<p>Reviewer narrative.</p>} notesCount={1} reviewed="2026-09-04" />,
    );

    const folds = container.querySelectorAll("details");
    expect(folds).toHaveLength(1);
    const fold = folds[0]!;
    expect(fold.open).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();

    const notes = screen.getByText("Reviewer narrative.");
    const firstSource = screen.getByRole("link", { name: "Issuer attestation", hidden: true });
    expect(fold.contains(notes)).toBe(true);
    expect(fold.contains(firstSource)).toBe(true);
    expect(notes.compareDocumentPosition(firstSource) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Notes plus sources: the count travels in the accessible name.
    const summary = fold.querySelector("summary")!;
    expect(accessibleText(summary).replace(/\s+/g, " ")).toMatch(/\(3\)/);
  });

  it("lists each source as a new-tab link named by its label, with the note after it", () => {
    render(
      <EvidenceFooter
        sources={[...SOURCES, { label: "Capacity report", url: "https://example.com/capacity", note: "Supports capacity" }]}
      />,
    );

    const list = screen.getByRole("list", { name: "Sources", hidden: true });
    const links = within(list).getAllByRole("link", { hidden: true });
    expect(links.map((link) => link.textContent)).toEqual(["Issuer attestation", "Custody agreement", "Capacity report"]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(links[2]!.getAttribute("href")).toBe("https://example.com/capacity");
    expect(links[2]!.closest("li")?.textContent).toBe("Capacity reportSupports capacity");
  });

  it("keeps the review date on the always-visible footer line, outside the fold", () => {
    const { container } = render(
      <EvidenceFooter sources={SOURCES} reviewed="2026-09-04" trailing="Live · 3h ago" />,
    );

    const stamp = screen.getByText("Reviewed 2026-09-04");
    expect(container.querySelector("details")?.contains(stamp)).toBe(false);
    expect(stamp.parentElement?.textContent).toBe("Live · 3h ago · Reviewed 2026-09-04");
  });

  it("renders no fold without notes or sources", () => {
    const { container } = render(<EvidenceFooter reviewed="2026-09-04" />);

    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByText(/2026-09-04/)).toBeTruthy();
  });

  it("anchors the merged fold so hash reveal can open it", () => {
    const { container } = render(
      <EvidenceFooter sources={SOURCES} notes={<p>Reviewer narrative.</p>} foldId="mint-review-notes" />,
    );

    expect(container.querySelector("details")?.id).toBe("mint-review-notes");
  });
});
