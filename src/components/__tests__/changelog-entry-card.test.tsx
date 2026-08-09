import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import type { ChangelogEntry } from "@/data/changelogs/types";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const MOCK_ENTRY: ChangelogEntry = {
  dateRange: { from: "2026-03-17", to: "2026-03-24" },
  summary: [
    { label: "New feature", description: "Something cool was added", tag: "feature" },
    { label: "Bug fix", description: "Something broken was fixed", tag: "infra" },
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
    expect(html).toContain("Mar 17 – 24");
  });

  it("renders summary items with labels", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("New feature");
    expect(html).toContain("Something cool was added");
    expect(html).toContain("Bug fix");
  });

  it("renders total commit count and show-commits toggle", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("42 commits");
    expect(html).toContain("Show commits");
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
