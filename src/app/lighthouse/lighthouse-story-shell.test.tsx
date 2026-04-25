// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LighthouseStoryModel } from "./story-model";
import { LighthouseStoryShell } from "./lighthouse-story-shell";

afterEach(() => cleanup());

const story = {
  activeChapterId: "harbor",
  activeChapter: {
    id: "harbor",
    label: "Harbor",
    kicker: "Harbor Below",
    summary: "Inspect chain harbors.",
    status: "available",
    ariaLabel: "Harbor Below: Inspect chain harbors.",
  },
  chapters: [
    {
      id: "harbor",
      label: "Harbor",
      kicker: "Harbor Below",
      summary: "Inspect chain harbors.",
      status: "available",
      ariaLabel: "Harbor Below: Inspect chain harbors.",
    },
    {
      id: "lens",
      label: "Lens",
      kicker: "Lens Room",
      summary: "Read PSI lens shutters.",
      status: "available",
      ariaLabel: "Lens Room: Read PSI lens shutters.",
    },
    {
      id: "storm",
      label: "Storm",
      kicker: "Storm Watch",
      summary: "Read DEWS pressure.",
      status: "disabled",
      ariaLabel: "Storm Watch: Read DEWS pressure.",
      unavailableReason: "stress-signals-unavailable",
    },
  ],
} as LighthouseStoryModel;

describe("LighthouseStoryShell", () => {
  it("renders chapter controls and switches available chapters", () => {
    const onChapterChange = vi.fn();
    render(
      <LighthouseStoryShell story={story} onChapterChange={onChapterChange}>
        <div>active panel</div>
      </LighthouseStoryShell>,
    );

    expect(screen.getByRole("tab", { name: /Harbor/i }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /Lens/i }));
    expect(onChapterChange).toHaveBeenCalledWith("lens");
    const stormTab = screen.getByRole("tab", { name: /Storm/i }) as HTMLButtonElement;
    expect(stormTab.disabled).toBe(true);
    expect(stormTab.getAttribute("aria-describedby")).toBe("lighthouse-chapter-unavailable-storm");
    expect(screen.getByText("Storm watch opens when DEWS stress signals load.")).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: /Harbor Below/i })).toBeTruthy();
  });
});
