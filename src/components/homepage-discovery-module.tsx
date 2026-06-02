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
      className="group pharos-focus-ring flex h-full flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 sm:px-5 sm:py-5"
    >
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-frost-blue group-focus-visible:text-frost-blue"
          strokeWidth={1.8}
        />
        <GroupTag label={suggestion.groupLabel} />
      </div>

      <div className="space-y-1.5">
        <p className="text-lg font-semibold leading-tight tracking-tight text-foreground">
          {suggestion.title}
        </p>
        <p className="max-w-[44ch] text-[13px] leading-relaxed text-muted-foreground">
          {suggestion.description}
        </p>
      </div>

      <div className="mt-auto flex items-center gap-1.5 pt-2">
        <span className="font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-frost-blue group-focus-visible:text-frost-blue">
          {suggestion.href}
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="h-3.5 w-3.5 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-frost-blue group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:text-frost-blue group-focus-visible:opacity-100"
          strokeWidth={2}
        />
      </div>
    </Link>
  );
}

function IndexRow({ suggestion }: { suggestion: HomepageDiscoverySuggestion }): JSX.Element {
  const Icon = suggestion.icon;

  return (
    <Link
      href={suggestion.href}
      className="group pharos-focus-ring flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 sm:px-5"
    >
      <GroupTag label={suggestion.groupLabel} className="w-[4.75rem] shrink-0 whitespace-nowrap" />
      <Icon
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-frost-blue group-focus-visible:text-frost-blue"
        strokeWidth={1.8}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {suggestion.title}
      </span>
      <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-frost-blue group-focus-visible:text-frost-blue sm:inline">
        {suggestion.href}
      </span>
      <ArrowUpRight
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-frost-blue group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:text-frost-blue group-focus-visible:opacity-100"
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
          <p className="pharos-kicker">Page Discovery</p>
          <h2 id="homepage-discovery-title" className="text-sm font-semibold tracking-tight text-foreground">
            Next surfaces to inspect
          </h2>
        </div>
        <p className="hidden shrink-0 font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-muted-foreground sm:block">
          Rotates each visit
        </p>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {featured ? (
          <div className="border-b border-border/45 lg:border-b-0 lg:border-r">
            <FeaturedSurface suggestion={featured} />
          </div>
        ) : null}

        <ul className="divide-y divide-border/40">
          {rest.map((suggestion) => (
            <li key={suggestion.href}>
              <IndexRow suggestion={suggestion} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
