"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { JSX } from "react";

import {
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  selectHomepageDiscoverySuggestions,
  type HomepageDiscoverySuggestion,
} from "@/lib/homepage-discovery";

const DEFAULT_SUGGESTIONS = selectHomepageDiscoverySuggestions(
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  0,
);

// Legible accent for text/graphical marks. frost-blue (oklch L .72) fails AA as
// small text on light surfaces, so accents use the token system's accessible
// blue pattern; the brand frost-blue is reserved for the decorative beam-wash
// and the ghost ordinal.
const ACCENT_TEXT = "text-blue-700 dark:text-blue-400";
const ACCENT_ON_HOVER =
  "group-hover:text-blue-700 group-focus-visible:text-blue-700 dark:group-hover:text-blue-400 dark:group-focus-visible:text-blue-400";

// The lighthouse beam catches a single surface from the top-left.
const FEATURED_BEAM_STYLE = {
  backgroundImage:
    "radial-gradient(125% 125% at 0% 0%, color-mix(in oklab, var(--brand-accent) 13%, transparent), transparent 58%)",
} as const;

function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function LighthouseMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 22V8l2-6 2 6v14" />
      <path d="M7 22h10" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
      <circle cx="12" cy="5" r="1.5" />
      <path d="M6 4l3.5 1M18 4l-3.5 1" />
    </svg>
  );
}

function GroupTag({ label, className }: { label: string; className?: string }): JSX.Element {
  return (
    <span
      className={`font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.14em] text-muted-foreground ${className ?? ""}`}
    >
      {label}
    </span>
  );
}

function FeaturedSurface({ suggestion }: { suggestion: HomepageDiscoverySuggestion }): JSX.Element {
  const Icon = suggestion.icon;

  return (
    <Link
      href={suggestion.href}
      className="group pharos-focus-ring flex h-full items-start gap-4 px-5 py-6 transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 sm:gap-5 sm:px-6 sm:py-7"
    >
      <span
        aria-hidden="true"
        className="font-mono text-[2.25rem] font-semibold leading-none tabular-nums text-frost-blue/40 transition-colors group-hover:text-frost-blue group-focus-visible:text-frost-blue sm:text-[2.75rem]"
      >
        {ordinal(0)}
      </span>

      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className={`h-4 w-4 ${ACCENT_TEXT}`} strokeWidth={1.9} />
          <GroupTag label={suggestion.groupLabel} />
        </div>

        <p className="text-2xl font-bold leading-[1.1] tracking-tight text-foreground">
          {suggestion.title}
        </p>
        <p className="max-w-[42ch] text-sm leading-relaxed text-muted-foreground">
          {suggestion.description}
        </p>

        <div className="flex items-center gap-1.5 pt-1">
          <span className={`font-mono text-xs ${ACCENT_TEXT}`}>{suggestion.href}</span>
          <ArrowUpRight
            aria-hidden="true"
            className={`h-4 w-4 opacity-0 transition-all duration-200 motion-safe:-translate-x-1 group-hover:opacity-100 motion-safe:group-hover:translate-x-0 group-focus-visible:opacity-100 motion-safe:group-focus-visible:translate-x-0 ${ACCENT_TEXT}`}
            strokeWidth={2}
          />
        </div>
      </div>
    </Link>
  );
}

function IndexRow({
  suggestion,
  index,
}: {
  suggestion: HomepageDiscoverySuggestion;
  index: number;
}): JSX.Element {
  return (
    <Link
      href={suggestion.href}
      className="group pharos-focus-ring flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 sm:gap-4 sm:px-5"
    >
      <span
        aria-hidden="true"
        className={`w-7 shrink-0 font-mono text-base font-semibold tabular-nums text-muted-foreground/60 transition-colors ${ACCENT_ON_HOVER}`}
      >
        {ordinal(index + 1)}
      </span>
      <GroupTag label={suggestion.groupLabel} className="w-[4.75rem] shrink-0 whitespace-nowrap" />
      <span className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-foreground">
        {suggestion.title}
      </span>
      <span
        className={`hidden shrink-0 font-mono text-[11px] text-muted-foreground transition-colors sm:inline ${ACCENT_ON_HOVER}`}
      >
        {suggestion.href}
      </span>
      <ArrowUpRight
        aria-hidden="true"
        className={`h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-all duration-200 motion-safe:-translate-x-1 group-hover:opacity-100 motion-safe:group-hover:translate-x-0 group-focus-visible:opacity-100 motion-safe:group-focus-visible:translate-x-0 ${ACCENT_ON_HOVER}`}
        strokeWidth={2}
      />
    </Link>
  );
}

export function HomepageDiscoveryModule({
  suggestions = DEFAULT_SUGGESTIONS,
}: {
  suggestions?: readonly HomepageDiscoverySuggestion[];
}): JSX.Element {
  const [featured, ...rest] = suggestions;

  return (
    <nav
      aria-labelledby="homepage-discovery-title"
      className="pharos-card-shell overflow-hidden p-0"
    >
      <div className="flex items-end justify-between gap-3 border-b border-border/45 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <p className="pharos-kicker flex items-center gap-1.5">
            <LighthouseMark className={`h-3.5 w-3.5 ${ACCENT_TEXT}`} />
            Page Discovery
          </p>
          <h2 id="homepage-discovery-title" className="mt-0.5 text-base font-semibold tracking-tight text-foreground">
            Next surfaces to inspect
          </h2>
        </div>
        <p className="hidden shrink-0 font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-muted-foreground sm:block">
          Rotates each visit
        </p>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {featured ? (
          <div
            style={FEATURED_BEAM_STYLE}
            className="border-b border-border/45 lg:border-b-0 lg:border-r"
          >
            <FeaturedSurface suggestion={featured} />
          </div>
        ) : null}

        <ul className="divide-y divide-border/40">
          {rest.map((suggestion, index) => (
            <li key={suggestion.href}>
              <IndexRow suggestion={suggestion} index={index} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
