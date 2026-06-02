"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { CSSProperties, JSX } from "react";

import {
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  selectHomepageDiscoverySuggestions,
  type HomepageDiscoverySuggestion,
} from "@/lib/homepage-discovery";
import { cn } from "@/lib/utils";

const DEFAULT_SUGGESTIONS = selectHomepageDiscoverySuggestions(
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  0,
);

function discoveryAccentStyle(suggestion: HomepageDiscoverySuggestion): CSSProperties {
  return { "--discovery-accent": suggestion.accent } as CSSProperties;
}

function GroupTag({ label }: { label: string }): JSX.Element {
  return (
    <span className="font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.14em] text-muted-foreground">
      {label}
    </span>
  );
}

function DiscoveryIcon({
  suggestion,
  featured = false,
}: {
  suggestion: HomepageDiscoverySuggestion;
  featured?: boolean;
}): JSX.Element {
  const Icon = suggestion.icon;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-md border bg-[color-mix(in_oklab,var(--discovery-accent)_8%,transparent)] text-[var(--discovery-accent)] transition-colors [border-color:color-mix(in_oklab,var(--discovery-accent)_23%,var(--border))] group-hover:bg-[color-mix(in_oklab,var(--discovery-accent)_14%,transparent)] group-hover:[border-color:color-mix(in_oklab,var(--discovery-accent)_42%,var(--border))] group-focus-visible:bg-[color-mix(in_oklab,var(--discovery-accent)_14%,transparent)] group-focus-visible:[border-color:color-mix(in_oklab,var(--discovery-accent)_42%,var(--border))]",
        featured ? "h-20 w-20 sm:h-24 sm:w-24" : "h-14 w-14 sm:h-16 sm:w-16 xl:h-20 xl:w-20",
      )}
    >
      <Icon
        aria-hidden="true"
        className={featured ? "h-9 w-9 sm:h-10 sm:w-10" : "h-7 w-7 sm:h-8 sm:w-8 xl:h-9 xl:w-9"}
        strokeWidth={1.85}
      />
    </span>
  );
}

function FeaturedSurface({ suggestion }: { suggestion: HomepageDiscoverySuggestion }): JSX.Element {
  return (
    <Link
      href={suggestion.href}
      style={discoveryAccentStyle(suggestion)}
      className="group pharos-focus-ring relative isolate flex h-full min-h-36 items-center gap-4 overflow-hidden px-4 py-4 transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:outline-none sm:gap-5 sm:px-5 xl:min-h-32"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(130%_140%_at_0%_0%,color-mix(in_oklab,var(--discovery-accent)_13%,transparent),transparent_58%)]"
      />
      <DiscoveryIcon suggestion={suggestion} featured />
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.14em] text-[var(--discovery-accent)]">
            Spotlight
          </span>
          <GroupTag label={suggestion.groupLabel} />
        </div>

        <p className="text-xl font-bold leading-[1.08] tracking-tight text-foreground sm:text-2xl">
          {suggestion.title}
        </p>
        <p className="line-clamp-2 max-w-[38ch] text-sm leading-relaxed text-muted-foreground">
          {suggestion.description}
        </p>

        <div className="flex items-center gap-1.5 pt-1">
          <span className="font-mono text-xs text-[var(--discovery-accent)]">{suggestion.href}</span>
          <ArrowUpRight
            aria-hidden="true"
            className="h-4 w-4 text-[var(--discovery-accent)] opacity-0 transition-all duration-200 motion-safe:-translate-x-1 group-hover:opacity-100 motion-safe:group-hover:translate-x-0 group-focus-visible:opacity-100 motion-safe:group-focus-visible:translate-x-0"
            strokeWidth={2}
          />
        </div>
      </div>
    </Link>
  );
}

function CompactSurface({
  suggestion,
}: {
  suggestion: HomepageDiscoverySuggestion;
}): JSX.Element {
  return (
    <Link
      href={suggestion.href}
      style={discoveryAccentStyle(suggestion)}
      className="group pharos-focus-ring flex h-full min-h-28 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:outline-none sm:gap-3.5 sm:px-5 xl:min-h-32"
    >
      <DiscoveryIcon suggestion={suggestion} />
      <div className="min-w-0">
        <GroupTag label={suggestion.groupLabel} />
        <p className="mt-1 font-mono text-[11px] font-semibold uppercase leading-tight tracking-wider text-foreground">
          {suggestion.title}
        </p>
        <p className="mt-1 truncate text-[11px] leading-snug text-muted-foreground">
          {suggestion.shortDescription}
        </p>
      </div>
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
    <nav aria-labelledby="homepage-discovery-title" className="pharos-card-shell overflow-hidden p-0">
      <h2 id="homepage-discovery-title" className="sr-only">
        Page Discovery
      </h2>

      <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,2.85fr)]">
        {featured ? (
          <div className="border-b border-border/40 lg:border-r lg:border-b-0">
            <FeaturedSurface suggestion={featured} />
          </div>
        ) : null}

        <ul className="grid md:grid-cols-2 xl:grid-cols-4">
          {rest.map((suggestion, index) => (
            <li
              key={suggestion.href}
              className={cn(
                "border-border/40",
                index < rest.length - 1 && "border-b",
                index % 2 === 0 && "md:border-r",
                index < 2 && "md:border-b",
                "xl:border-r xl:border-b-0",
                index === rest.length - 1 && "xl:border-r-0",
              )}
            >
              <CompactSurface suggestion={suggestion} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
