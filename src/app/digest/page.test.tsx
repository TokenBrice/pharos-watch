// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("@/components/digest-archive-client", () => ({
  DigestArchiveClient: () => <section data-testid="digest-archive-client" />,
}));

import DigestArchivePage from "./page";
import digests from "../../../data/digests.json";

const latestDaily = digests.find((entry) => entry.digestType !== "weekly") ?? digests[0];

afterEach(() => {
  cleanup();
});

describe("DigestArchivePage", () => {
  it("renders the broadsheet nameplate with the latest edition and default writer credit", () => {
    const { container } = render(<DigestArchivePage />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("Pharos Digest");

    expect(container.textContent).toContain(`Issue #${latestDaily.editionNumber}`);
    expect(container.textContent).toContain("Written by AI");
  });

  it("drops the duplicated weekly recap module", () => {
    render(<DigestArchivePage />);
    expect(screen.queryByText("Weekly market recaps")).toBeNull();
  });

  it("keeps every daily and weekly digest in the static monthly archive index", () => {
    const html = renderToStaticMarkup(<DigestArchivePage />);
    const document = new DOMParser().parseFromString(html, "text/html");
    const index = document.querySelector('nav[aria-labelledby="digest-month-index"]')!;
    expect(index).not.toBeNull();
    expect(index.classList.contains("sr-only")).toBe(false);
    const links = Array.from(index.querySelectorAll("details ul a"));
    expect(links.map((link) => link.getAttribute("href")?.replace(/\/$/, "")).sort()).toEqual(
      digests.map((entry) => `/digest/${entry.date}`).sort(),
    );
    expect(index.querySelectorAll("summary")).toHaveLength(
      new Set(digests.map((entry) => entry.date.slice(0, 7))).size,
    );
  });

  it("renders the Telegram subscribe wire and one-line colophon", () => {
    const { container } = render(<DigestArchivePage />);
    expect(screen.getByRole("link", { name: /Join the Telegram channel/ })).toBeTruthy();
    expect(container.textContent).toContain("Watching the peg");
    expect(container.textContent).toContain("Not financial advice");
  });
});
