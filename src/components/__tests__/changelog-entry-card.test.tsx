import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import type { ChangelogEntry } from "@/data/changelogs/types";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const MOCK_ENTRY: ChangelogEntry = {
  dateRange: { from: "2026-03-17", to: "2026-03-24" },
  summary: [
    { label: "New feature", description: "Something cool was added" },
    { label: "Bug fix", description: "Something broken was fixed" },
  ],
  stats: { totalCommits: 42 },
  commits: [
    { hash: "abc1234", message: "feat: add cool thing" },
    { hash: "def5678", message: "fix: broken thing" },
  ],
};

describe("ChangelogEntryCard", () => {
  it("renders the date range", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("Mar 17");
    expect(html).toContain("24, 2026");
  });

  it("renders summary items with labels", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("New feature");
    expect(html).toContain("Something cool was added");
    expect(html).toContain("Bug fix");
  });

  it("renders commit count in details summary", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("2 commits");
  });

  it("renders collapsible commit list", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("abc1234");
    expect(html).toContain("feat: add cool thing");
    expect(html).toContain("<details");
  });

  it("has an anchor id based on the end date", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain('id="2026-03-24"');
  });
});
