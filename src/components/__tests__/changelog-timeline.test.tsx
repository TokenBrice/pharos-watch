// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChangelogTimeline } from "@/components/methodology-history/changelog-timeline";
import { changelogs } from "@/data/changelogs";
import {
  CHANGELOG_MONTH_ARCHIVES,
  RECENT_CHANGELOGS,
  formatChangelogDateRange,
  getAdjacentChangelogMonths,
  summarizeChangelogEntries,
} from "@/lib/changelog-history";

afterEach(cleanup);

describe("ChangelogTimeline partitions", () => {
  it("renders only the recent partition, not hidden historical bodies", () => {
    render(<ChangelogTimeline entries={RECENT_CHANGELOGS} />);
    for (const entry of RECENT_CHANGELOGS) {
      const week = document.getElementById(`week-${entry.dateRange.to}`);
      const card = document.getElementById(entry.dateRange.to);
      expect(week).not.toBeNull();
      expect(card).not.toBeNull();
      expect(card?.getAttribute("aria-labelledby")).toBe(`week-heading-${entry.dateRange.to}`);
      const heading = document.getElementById(`week-heading-${entry.dateRange.to}`);
      expect(heading?.className).toContain("text-foreground");
      expect(heading?.className).not.toContain("text-muted-foreground");
      expect(heading?.textContent).toContain(entry.dateRange.to.slice(0, 4));
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

  it("filters updates client-side by tag without unmounting week anchors", () => {
    render(<ChangelogTimeline entries={RECENT_CHANGELOGS} />);
    const allBtn = screen.getByRole("button", { name: /^All\b/ });
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");

    const designBtn = screen.getByRole("button", { name: /^Design\b/ });
    fireEvent.click(designBtn);
    expect(designBtn.getAttribute("aria-pressed")).toBe("true");
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");
    expect(designBtn.closest("[data-active-tag]")?.getAttribute("data-active-tag")).toBe("design");

    for (const entry of RECENT_CHANGELOGS) {
      const week = document.getElementById(`week-${entry.dateRange.to}`);
      expect(week).not.toBeNull();
      expect(document.getElementById(entry.dateRange.to)).not.toBeNull();
      expect(week?.textContent).toContain(String(entry.stats.totalCommits));
    }

    expect(screen.getByText("No design items this week.")).toBeTruthy();

    // Clicking the active tag again clears back to All.
    fireEvent.click(designBtn);
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(designBtn.closest("[data-active-tag]")?.getAttribute("data-active-tag")).toBe("all");
  });

  it("renders ADR-34 commit bounds, GitHub range link, and Methodology chips", () => {
    render(<ChangelogTimeline entries={RECENT_CHANGELOGS} />);
    const latest = RECENT_CHANGELOGS[0];
    const latestCard = document.getElementById(latest.dateRange.to)!;

    expect(latestCard.textContent).toContain(
      `Recent commits (${latest.commits.length} of ${latest.stats.totalCommits})`,
    );
    const rangeLink = latestCard.querySelector(
      `a[href="https://github.com/TokenBrice/pharos-watch/commits/main/?since=${latest.dateRange.from}T00:00:00Z&until=${latest.dateRange.to}T23:59:59Z"]`,
    );
    expect(rangeLink).not.toBeNull();
    expect(latestCard.textContent).toContain("Methodology");
  });

  it("derives UTC date ranges, summaries, and adjacent months deterministically", () => {
    expect(formatChangelogDateRange("2026-11-16", "2026-11-22")).toBe("Nov 16 – 22, 2026");
    expect(formatChangelogDateRange("2026-10-26", "2026-11-01")).toBe("Oct 26 – Nov 1, 2026");
    expect(formatChangelogDateRange("2025-12-29", "2026-01-04")).toBe("Dec 29, 2025 – Jan 4, 2026");
    expect(formatChangelogDateRange("2026-11-16", "2026-11-22", { compact: true })).toBe("Nov 16 – 22");

    const newest = CHANGELOG_MONTH_ARCHIVES[0];
    const oldest = CHANGELOG_MONTH_ARCHIVES.at(-1)!;
    expect(getAdjacentChangelogMonths(newest.month).next).toBeNull();
    expect(getAdjacentChangelogMonths(newest.month).previous?.month).toBe(
      CHANGELOG_MONTH_ARCHIVES[1]?.month ?? null,
    );
    expect(getAdjacentChangelogMonths(oldest.month).previous).toBeNull();
    expect(getAdjacentChangelogMonths(oldest.month).next?.month).toBe(
      CHANGELOG_MONTH_ARCHIVES.at(-2)?.month ?? null,
    );

    const summary = summarizeChangelogEntries(RECENT_CHANGELOGS);
    expect(summary.weeks).toBe(RECENT_CHANGELOGS.length);
    expect(summary.totalCommits).toBe(
      RECENT_CHANGELOGS.reduce((sum, entry) => sum + entry.stats.totalCommits, 0),
    );
    expect(summary.methodologyLinks).toBeGreaterThan(0);
  });
});
