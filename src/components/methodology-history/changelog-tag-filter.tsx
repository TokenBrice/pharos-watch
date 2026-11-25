"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { CHANGELOG_TAG_LABELS, type ChangelogTag } from "@/lib/changelog-tags";

interface ChangelogTagFilterProps {
  presentTags: readonly ChangelogTag[];
  tagCounts: Record<ChangelogTag, number>;
  totalUpdates: number;
  children: ReactNode;
}

const ACTIVE_TAG_FILTER_CLASS = [
  "data-[active-tag=feature]:[&_[data-changelog-item]:not([data-tag=feature])]:hidden",
  "data-[active-tag=feature]:[&_[data-changelog-list]:not([data-has-feature])]:hidden",
  "data-[active-tag=feature]:[&_[data-changelog-empty=feature]]:block",
  "data-[active-tag=coverage]:[&_[data-changelog-item]:not([data-tag=coverage])]:hidden",
  "data-[active-tag=coverage]:[&_[data-changelog-list]:not([data-has-coverage])]:hidden",
  "data-[active-tag=coverage]:[&_[data-changelog-empty=coverage]]:block",
  "data-[active-tag=security]:[&_[data-changelog-item]:not([data-tag=security])]:hidden",
  "data-[active-tag=security]:[&_[data-changelog-list]:not([data-has-security])]:hidden",
  "data-[active-tag=security]:[&_[data-changelog-empty=security]]:block",
  "data-[active-tag=design]:[&_[data-changelog-item]:not([data-tag=design])]:hidden",
  "data-[active-tag=design]:[&_[data-changelog-list]:not([data-has-design])]:hidden",
  "data-[active-tag=design]:[&_[data-changelog-empty=design]]:block",
  "data-[active-tag=infra]:[&_[data-changelog-item]:not([data-tag=infra])]:hidden",
  "data-[active-tag=infra]:[&_[data-changelog-list]:not([data-has-infra])]:hidden",
  "data-[active-tag=infra]:[&_[data-changelog-empty=infra]]:block",
].join(" ");

/**
 * Tiny client-only category filter leaf for `ChangelogTimeline`. Receives only
 * precomputed tag counts so server-rendered timeline markup and commit data
 * never enter the client JS bundle.
 */
export function ChangelogTagFilter({
  presentTags,
  tagCounts,
  totalUpdates,
  children,
}: ChangelogTagFilterProps) {
  const [activeTag, setActiveTag] = useState<ChangelogTag | null>(null);
  const effectiveActiveTag = activeTag && tagCounts[activeTag] > 0 ? activeTag : null;

  return (
    <div data-active-tag={effectiveActiveTag ?? "all"} className={ACTIVE_TAG_FILTER_CLASS}>
      <div
        role="group"
        aria-label="Filter updates by category"
        className="mb-6 flex flex-wrap items-center gap-1.5"
      >
        <button
          type="button"
          aria-pressed={effectiveActiveTag === null}
          onClick={() => setActiveTag(null)}
          className="pharos-control-pill pharos-focus-ring gap-1.5"
        >
          <span>All</span>{" "}
          <span className="pharos-numeric text-muted-foreground">{totalUpdates}</span>
        </button>
        {presentTags.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-pressed={effectiveActiveTag === tag}
            onClick={() => setActiveTag((current) => (current === tag ? null : tag))}
            className="pharos-control-pill pharos-focus-ring gap-1.5"
          >
            <span>{CHANGELOG_TAG_LABELS[tag]}</span>{" "}
            <span className="pharos-numeric text-muted-foreground">{tagCounts[tag]}</span>
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {effectiveActiveTag
          ? `Showing ${tagCounts[effectiveActiveTag]} ${CHANGELOG_TAG_LABELS[effectiveActiveTag].toLowerCase()} updates.`
          : `Showing all ${totalUpdates} updates.`}
      </p>
      {children}
    </div>
  );
}
