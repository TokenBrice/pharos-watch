// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("@/components/digest-archive-client", () => ({
  DigestArchiveClient: () => <section data-testid="digest-archive-client" />,
}));

vi.mock("@/components/digest-nameplate-live", () => ({
  DigestNameplateLive: () => null,
}));

import DigestArchivePage from "./page";
import digests from "../../../data/digests.json";

describe("DigestArchivePage", () => {
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
});
