// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChangelogTimeline } from "@/components/changelog-timeline";
import { changelogs } from "@/data/changelogs";
import { CHANGELOG_MONTH_ARCHIVES, RECENT_CHANGELOGS } from "@/lib/changelog-history";

afterEach(cleanup);

describe("ChangelogTimeline partitions", () => {
  it("renders only the recent partition, not hidden historical bodies", () => {
    render(<ChangelogTimeline entries={RECENT_CHANGELOGS} />);
    for (const entry of RECENT_CHANGELOGS) {
      expect(document.getElementById(`week-${entry.dateRange.to}`)).not.toBeNull();
      expect(document.getElementById(entry.dateRange.to)).not.toBeNull();
    }
    expect(document.getElementById(`week-${changelogs.at(-1)!.dateRange.to}`)).toBeNull();
  });

  it("retains both public week anchors and authoritative commit totals in complete month archives", () => {
    const archive = CHANGELOG_MONTH_ARCHIVES.at(-1)!;
    render(<ChangelogTimeline entries={archive.entries} highlightLatest={false} />);
    for (const entry of archive.entries) {
      const week = document.getElementById(`week-${entry.dateRange.to}`);
      expect(week?.textContent).toContain(String(entry.stats.totalCommits));
      expect(document.getElementById(entry.dateRange.to)).not.toBeNull();
    }
  });
});
