// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DigestArchivePage from "./page";
import digests from "../../../data/digests.json";

vi.mock("@/components/digest-archive-client", () => ({
  DigestArchiveClient: () => <section data-testid="digest-archive-client" />,
}));

vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

afterEach(() => {
  cleanup();
});

describe("DigestArchivePage", () => {
  it("keeps only the two newest weekly recaps expanded by default", () => {
    const weeklyDigests = digests.filter((entry) => entry.digestType === "weekly");
    const [newest, secondNewest, oldestHidden] = weeklyDigests;

    render(<DigestArchivePage />);

    const weeklySection = screen.getByRole("heading", { name: "Weekly market recaps" }).closest("section");
    expect(weeklySection).toBeTruthy();

    const visibleGrid = weeklySection?.querySelector(":scope > div.grid") as HTMLElement | null;
    expect(visibleGrid).toBeTruthy();

    const visibleWeeklyLinks = within(visibleGrid as HTMLElement).getAllByRole("link");
    expect(visibleWeeklyLinks).toHaveLength(2);
    expect(within(visibleGrid as HTMLElement).getByRole("link", { name: new RegExp(newest.title, "i") })).toBeTruthy();
    expect(within(visibleGrid as HTMLElement).getByRole("link", { name: new RegExp(secondNewest.title, "i") })).toBeTruthy();
    expect(within(visibleGrid as HTMLElement).queryByRole("link", { name: new RegExp(oldestHidden.title, "i") })).toBeNull();

    const olderRecaps = within(weeklySection as HTMLElement).getByText(
      `Show ${weeklyDigests.length - 2} older weekly recaps`,
    );
    const details = olderRecaps.closest("details");
    expect(details).toBeTruthy();
    expect(within(details as HTMLElement).getByRole("link", { name: new RegExp(oldestHidden.title, "i") })).toBeTruthy();
  });
});
