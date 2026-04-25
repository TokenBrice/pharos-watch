"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LighthouseChapterId, LighthouseStoryModel } from "./story-model";
import "./lighthouse-story.css";

const UNAVAILABLE_REASON_COPY: Record<string, string> = {
  "chain-data-unavailable": "Chain harbor data has not loaded yet.",
  "psi-unavailable": "PSI lens data has not loaded yet.",
  "selected-harbor-unavailable": "Select a harbor before opening the ledger.",
  "stress-signals-unavailable": "Storm watch opens when DEWS stress signals load.",
};

function formatUnavailableReason(reason: string | undefined): string {
  if (!reason) return "This chapter is unavailable right now.";
  return UNAVAILABLE_REASON_COPY[reason] ?? "This chapter is unavailable right now.";
}

export function LighthouseStoryShell({
  story,
  onChapterChange,
  children,
}: {
  story: LighthouseStoryModel;
  onChapterChange: (chapterId: LighthouseChapterId) => void;
  children: ReactNode;
}) {
  const disabledChapters = story.chapters.filter((chapter) => chapter.status === "disabled");

  return (
    <section className="lh-watch-experience" aria-labelledby="lighthouse-story-heading">
      <div className="lh-watch-heading">
        <div className="lh-watch-heading__copy">
          <p className="pharos-kicker">The Watch at Pharos</p>
          <h2 id="lighthouse-story-heading" className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Enter the lens room
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            The page reads like a night watch from inside Pharos: the lens projects the chain fleet, the weather line
            carries aggregate stress, and every illuminated mark resolves back into the ledger.
          </p>
        </div>

        <div className="lh-story-tabs" role="tablist" aria-label="Lighthouse story chapters">
          {story.chapters.map((chapter, index) => {
            const active = chapter.id === story.activeChapterId;
            const disabled = chapter.status === "disabled";
            return (
              <button
                key={chapter.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`lighthouse-chapter-${chapter.id}`}
                aria-describedby={disabled ? `lighthouse-chapter-unavailable-${chapter.id}` : undefined}
                disabled={disabled}
                title={disabled ? formatUnavailableReason(chapter.unavailableReason) : chapter.summary}
                className={cn("lh-story-tab pharos-focus-ring", active && "lh-story-tab--active")}
                onClick={() => onChapterChange(chapter.id)}
              >
                <span className="lh-story-tab__index">{String(index + 1).padStart(2, "0")}</span>
                <span className="lh-story-tab__label">{chapter.label}</span>
              </button>
            );
          })}
        </div>

        {disabledChapters.length > 0 ? (
          <div className="lh-story-unavailable" aria-live="polite">
            {disabledChapters.map((chapter) => (
              <p id={`lighthouse-chapter-unavailable-${chapter.id}`} key={chapter.id}>
                <span>{chapter.label}</span>
                {formatUnavailableReason(chapter.unavailableReason)}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <div
        id={`lighthouse-chapter-${story.activeChapter.id}`}
        role="tabpanel"
        aria-label={story.activeChapter.ariaLabel}
        className="lh-story-panel"
      >
        <div className="lh-story-panel__header">
          <div>
            <p className="pharos-kicker">{story.activeChapter.kicker}</p>
            <p className="text-sm text-muted-foreground">{story.activeChapter.summary}</p>
          </div>
          <div className="lh-story-panel__status">
            {story.activeChapter.status === "available" ? "live chapter" : "data unavailable"}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}
