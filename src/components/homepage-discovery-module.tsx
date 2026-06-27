"use client";

import Link from "next/link";
import { RotateCw } from "lucide-react";
import { useMemo, useState, type CSSProperties, type JSX } from "react";

import {
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  selectHomepageDiscoverySuggestions,
  type HomepageDiscoverySuggestion,
} from "@/lib/homepage-discovery";
import { cn } from "@/lib/utils";

const DEFAULT_SUGGESTIONS = selectHomepageDiscoverySuggestions(HOMEPAGE_DISCOVERY_ROTATION_POOL, 9);

function discoveryAccentStyle(suggestion: HomepageDiscoverySuggestion): CSSProperties {
  return { "--discovery-accent": suggestion.accent } as CSSProperties;
}

function staggerStyle(index: number): CSSProperties {
  return { "--stagger-index": index } as CSSProperties;
}

// Neutral category chip — monochrome control surface; the route's hue lives only
// in the icon so the row reads calm. The spotlight route swaps its group label
// for "Spotlight".
function CategoryChip({ label }: { label: string }): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/50 px-3 py-1 font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.14em] text-muted-foreground">
      {label}
    </span>
  );
}

function DiscoveryIcon({ suggestion }: { suggestion: HomepageDiscoverySuggestion }): JSX.Element {
  const Icon = suggestion.icon;

  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_oklab,var(--discovery-accent)_15%,transparent)] text-[var(--discovery-accent)] transition-[background-color,border-color] duration-200 group-hover:bg-[color-mix(in_oklab,var(--discovery-accent)_23%,transparent)] group-focus-visible:bg-[color-mix(in_oklab,var(--discovery-accent)_23%,transparent)]"
    >
      <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.95} />
    </span>
  );
}

// One route entry. Equal-width across the row; the Figma target keeps the first
// tile's "Spotlight" chip but puts the tinted descriptive treatment on the
// second tile, so the strip reads as a compact carousel preview without a pager.
function RouteCard({
  suggestion,
  featured,
  spotlightLabel,
  index,
  total,
}: {
  suggestion: HomepageDiscoverySuggestion;
  featured: boolean;
  spotlightLabel: boolean;
  index: number;
  total: number;
}): JSX.Element {
  return (
    <li style={staggerStyle(index)} className={cn("border-border/50", index < total - 1 && "border-r")}>
      <Link
        href={suggestion.href}
        style={discoveryAccentStyle(suggestion)}
        className={cn(
          "group pharos-focus-ring relative flex h-[162px] flex-col gap-4 px-5 py-5 transition-colors focus-visible:outline-none",
          featured
            ? "bg-[color-mix(in_oklab,var(--discovery-accent)_9%,transparent)] after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-16 after:bg-[color-mix(in_oklab,var(--discovery-accent)_68%,var(--border))]"
            : "hover:bg-[color-mix(in_oklab,var(--discovery-accent)_5%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--discovery-accent)_5%,transparent)]",
        )}
      >
        <div className="flex items-center gap-2">
          <DiscoveryIcon suggestion={suggestion} />
          <span aria-hidden="true" className="h-px flex-1 bg-border/50" />
          <CategoryChip label={spotlightLabel ? "Spotlight" : suggestion.groupLabel} />
        </div>

        <div className="mt-auto min-w-0">
          <p className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
            {suggestion.title}
          </p>
          {featured ? (
            <p className="mt-2 line-clamp-2 text-sm leading-snug text-muted-foreground">
              {suggestion.description}
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

export function HomepageDiscoveryModule({
  suggestions = DEFAULT_SUGGESTIONS,
}: {
  suggestions?: readonly HomepageDiscoverySuggestion[];
}): JSX.Element {
  // Refresh re-rolls the visible window over the rotation pool; the initial
  // render keeps the server-selected `suggestions` so hydration matches.
  const [spotlight, setSpotlight] = useState(0);
  const visible = useMemo(
    () =>
      spotlight === 0 ? suggestions : selectHomepageDiscoverySuggestions(HOMEPAGE_DISCOVERY_ROTATION_POOL, spotlight),
    [spotlight, suggestions],
  );
  const total = visible.length;

  return (
    <nav aria-labelledby="homepage-discovery-title" className="space-y-3 sm:space-y-4">
      <h2 id="homepage-discovery-title" className="sr-only">
        Page Discovery
      </h2>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="space-y-1 sm:space-y-1.5">
          <p className="pharos-display text-base font-bold text-foreground sm:text-3xl">Chart Your Route</p>
          <p className="max-w-[13rem] text-[10px] leading-snug text-muted-foreground sm:max-w-none sm:text-sm">
            Different ways into Pharos — refreshed every time you visit.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSpotlight((value) => value + (suggestions.length || 5))}
          className="pharos-focus-ring group inline-flex min-h-7 items-center gap-1.5 rounded-[4px] border border-border/70 bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-border hover:bg-muted/60"
        >
          Refresh
          <RotateCw
            aria-hidden="true"
            className="h-3 w-3 text-muted-foreground transition-transform duration-300 group-hover:rotate-90 group-hover:text-foreground"
            strokeWidth={2}
          />
        </button>
      </div>

      <ul className="pharos-card-shell grid grid-cols-5 overflow-hidden rounded-lg">
        {visible.map((suggestion, index) => (
          <RouteCard
            key={suggestion.href}
            suggestion={suggestion}
            featured={index === 1}
            spotlightLabel={index === 0}
            index={index}
            total={total}
          />
        ))}
      </ul>
    </nav>
  );
}
