// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("keeps every digest in the crawlable archive index", () => {
    render(<DigestArchivePage />);
    const index = screen.getByRole("navigation", { name: "Digest archive index" });
    expect(within(index).getAllByRole("link")).toHaveLength(digests.length);
  });

  it("renders the Telegram subscribe wire and one-line colophon", () => {
    const { container } = render(<DigestArchivePage />);
    expect(screen.getByRole("link", { name: /Join the Telegram channel/ })).toBeTruthy();
    expect(container.textContent).toContain("Watching the peg");
    expect(container.textContent).toContain("Not financial advice");
  });
});
