// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChangelogTimeline } from "@/components/changelog-timeline";
import { openDisclosuresForHash } from "@/components/disclosure-hash-reveal";
import { changelogs } from "@/data/changelogs";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
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
