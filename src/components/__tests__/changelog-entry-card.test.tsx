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
  it("renders the populated entry with its date anchor and expandable commits", () => {
    const html = renderToStaticMarkup(<ChangelogEntryCard entry={MOCK_ENTRY} />);
    expect(html).toContain("Mar 17 – 24");
    expect(html).toContain("New feature");
    expect(html).toContain("Something cool was added");
    expect(html).toContain("Bug fix");
    expect(html).toContain("42 commits");
    expect(html).toContain("Show commits");
    expect(html).toContain("abc1234");
    expect(html).toContain("feat: add cool thing");
    expect(html).toContain("<details");
    expect(html).toContain('id="2026-03-24"');
  });
});
