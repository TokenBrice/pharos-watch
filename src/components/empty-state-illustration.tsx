"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Search, BarChart3, Filter, AlertTriangle, Telescope } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Five canonical empty-state archetypes used across Pharos surfaces.
 * - `no-data`        — first-load with no data (e.g., a new portfolio).
 * - `no-matches`     — filters returned zero rows.
 * - `no-results`     — search returned zero rows.
 * - `network-error`  — fetch failed; surface retry, not absence.
 * - `coverage-gap`   — this coin/peg/chain isn't ingested for this signal yet.
 */
export type EmptyStateKind =
  | "no-data"
  | "no-matches"
  | "no-results"
  | "network-error"
  | "coverage-gap";

export interface EmptyStateIllustrationProps {
  kind: EmptyStateKind;
  /** Optional override for the default title. */
  title?: string;
  /** Optional override for the default description. */
  description?: string;
  /** Optional CTA rendered below the copy (e.g. "Clear filters", "View coverage"). */
  action?: ReactNode;
  /** Context fragment used to enrich `coverage-gap` copy, e.g. "for /flows". */
  context?: string;
  className?: string;
}

const ICONS: Record<EmptyStateKind, typeof Search> = {
  "no-data": BarChart3,
  "no-matches": Filter,
  "no-results": Search,
  "network-error": AlertTriangle,
  "coverage-gap": Telescope,
};

const DEFAULT_TITLES: Record<EmptyStateKind, string> = {
  "no-data": "No reads yet.",
  "no-matches": "No rows match these filters.",
  "no-results": "Nothing matched.",
  "network-error": "We couldn't reach the data.",
  "coverage-gap": "This signal isn't tracked yet.",
};

const DEFAULT_DESCRIPTIONS: Record<EmptyStateKind, string> = {
  "no-data":
    "Pharos is still gathering data for this section. Check back soon for updates.",
  "no-matches":
    "Try widening or clearing a filter to see the tracked universe.",
  "no-results":
    "Try adjusting your search terms or clearing filters to see more stablecoins.",
  "network-error":
    "The request didn't come back. Retry, or check the status page if it keeps happening.",
  "coverage-gap":
    "Pharos doesn't ingest this signal here yet. See the coverage page for what is tracked.",
};

/**
 * Pharos-branded empty state illustration.
 * Codifies five canonical archetypes (E1 / IDEA-7) so trackers stop shipping
 * one-off copy. Frost-blue accent aligns with brand identity.
 */
export function EmptyStateIllustration({
  kind,
  title,
  description,
  action,
  context,
  className,
}: EmptyStateIllustrationProps) {
  const Icon = ICONS[kind];
  const resolvedTitle = title ?? DEFAULT_TITLES[kind];
  const baseDescription = description ?? DEFAULT_DESCRIPTIONS[kind];
  const resolvedDescription =
    kind === "coverage-gap" && context ? `${baseDescription.replace(/\.$/, "")} ${context}.` : baseDescription;
  const showCoverageLink = kind === "coverage-gap" && !action;

  return (
    <div className={cn("flex flex-col items-center justify-center py-10 text-center", className)}>
      {/* Icon container with frost-blue accent */}
      <div className="relative mb-4">
        {/* Background glow */}
        <div
          className="absolute inset-0 rounded-full blur-xl opacity-30"
          style={{
            background: "radial-gradient(circle at center, var(--brand-accent), transparent 70%)",
            transform: "scale(1.5)",
          }}
        />
        {/* Icon container */}
        <div className="relative rounded-full border border-[var(--brand-accent)]/20 bg-[var(--brand-accent)]/5 p-4">
          <Icon
            className="h-8 w-8 text-[var(--brand-accent)]"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Text content */}
      <h3 className="text-base font-semibold text-foreground">{resolvedTitle}</h3>
      <p className="mt-1.5 max-w-[320px] text-sm text-muted-foreground leading-relaxed">
        {resolvedDescription}
      </p>

      {action ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}

      {showCoverageLink ? (
        <Link
          href="/coverage/"
          className="pharos-focus-ring mt-4 inline-flex min-h-9 items-center rounded-full border border-border/60 bg-background/60 px-3.5 text-sm font-medium text-foreground hover:bg-background/85"
        >
          View coverage
        </Link>
      ) : null}
    </div>
  );
}
