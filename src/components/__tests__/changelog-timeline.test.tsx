// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChangelogTimeline, groupChangelogEntries } from "@/components/changelog-timeline";
import { openDisclosuresForHash } from "@/components/disclosure-hash-reveal";
import { changelogs } from "@/data/changelogs";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("groupChangelogEntries", () => {
  it("keeps the newest weeks open and folds the rest into newest-first month groups", () => {
    const { recent, months } = groupChangelogEntries(changelogs, 2);

    expect(recent).toEqual(changelogs.slice(0, 2));
    expect(months.flatMap((month) => month.entries)).toEqual(changelogs.slice(2));
    for (const month of months) {
      expect(month.entries.every((entry) => entry.dateRange.to.startsWith(month.key))).toBe(true);
      expect(month.totalCommits).toBe(month.entries.reduce((sum, entry) => sum + entry.stats.totalCommits, 0));
    }
    expect(new Set(months.map((month) => month.key)).size).toBe(months.length);
  });
});

describe("ChangelogTimeline", () => {
  it("renders folded weeks in the markup and opens their month for a deep link", () => {
    render(<ChangelogTimeline entries={changelogs} />);
    const folded = changelogs.at(-1)!;
    const weekItem = document.getElementById(`week-${folded.dateRange.to}`);
    const month = weekItem?.closest("details");

    expect(weekItem?.textContent).toContain(String(folded.stats.totalCommits));
    expect(month?.open).toBe(false);

    expect(openDisclosuresForHash(`#${folded.dateRange.to}`)?.id).toBe(folded.dateRange.to);
    expect(month?.open).toBe(true);
    expect(openDisclosuresForHash(`#${folded.dateRange.to}`)).toBeNull();
    expect(openDisclosuresForHash(`#week-${changelogs[0].dateRange.to}`)).toBeNull();
  });
});
