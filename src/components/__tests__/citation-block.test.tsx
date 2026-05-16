// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CitationBlock } from "@/components/citation-block";

afterEach(cleanup);

describe("CitationBlock", () => {
  const baseProps = {
    entityClass: "coin" as const,
    id: "usdc-circle",
    title: "USDC (Circle) Stablecoin Analytics",
    url: "https://pharos.watch/stablecoin/usdc-circle/",
    accessedDate: "2026-05-16",
  };

  it("renders the URN and accessed date in the header", () => {
    render(<CitationBlock {...baseProps} />);
    expect(screen.getByText(/Cite this page/i)).toBeTruthy();
    const urnCode = document.querySelector("code.font-mono");
    expect(urnCode?.textContent).toBe("urn:pharos:coin:usdc-circle");
    expect(screen.getByText(/Accessed 2026-05-16/)).toBeTruthy();
  });

  it("defaults to BibTeX and renders the citation body", () => {
    render(<CitationBlock {...baseProps} />);
    const pre = document.querySelector('[data-format="bibtex"]');
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain("@misc{coin_usdc-circle,");
    expect(pre?.textContent).toContain("Pharos Watch");
  });

  it("switches to APA format on tab change", () => {
    render(<CitationBlock {...baseProps} />);
    fireEvent.click(screen.getByRole("radio", { name: /APA 7/i }));
    const pre = document.querySelector('[data-format="apa"]');
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain("Pharos Watch. (2026, May 16).");
    expect(pre?.textContent).toContain("Retrieved 2026-05-16");
  });

  it("switches to Chicago format on tab change", () => {
    render(<CitationBlock {...baseProps} />);
    fireEvent.click(screen.getByRole("radio", { name: /Chicago/i }));
    const pre = document.querySelector('[data-format="chicago"]');
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain(`"USDC (Circle) Stablecoin Analytics."`);
  });

  it("switches to plain URL+URN format on tab change", () => {
    render(<CitationBlock {...baseProps} />);
    fireEvent.click(screen.getByRole("radio", { name: /URL \+ URN/i }));
    const pre = document.querySelector('[data-format="plain"]');
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toBe(
      "USDC (Circle) Stablecoin Analytics — https://pharos.watch/stablecoin/usdc-circle/ — urn:pharos:coin:usdc-circle",
    );
  });

  it("includes a qualifier in the URN when provided", () => {
    render(
      <CitationBlock
        entityClass="methodology"
        id="dews"
        qualifier="v4.2"
        title="Pharos DEWS Methodology"
        url="https://pharos.watch/methodology/depeg-changelog/"
        accessedDate="2026-05-16"
        version="v4.2"
      />,
    );
    const urnCode = document.querySelector("code.font-mono");
    expect(urnCode?.textContent).toBe("urn:pharos:methodology:dews@v4.2");
  });

  it("resolves dynamic route accessed dates from the sitemap manifest", () => {
    render(
      <CitationBlock
        entityClass="depeg-event"
        id="usdc-2023-03-11"
        title="USDC depeg"
        url="https://pharos.watch/depeg/usdc-2023-03-11/"
      />,
    );
    expect(screen.getByText(/Accessed 2026-/)).toBeTruthy();
  });

  it("renders a copy button", () => {
    render(<CitationBlock {...baseProps} />);
    expect(screen.getByLabelText(/Copy to clipboard/i)).toBeTruthy();
  });
});
