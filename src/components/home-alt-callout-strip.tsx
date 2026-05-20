"use client";

import Link from "next/link";
import type { JSX } from "react";

import {
  BeaconEmblem,
  LiquidityEmblem,
  SafetyEmblem,
  SelectorEmblem,
  YieldEmblem,
} from "@/components/home-alt-callouts/emblems";

interface CalloutItem {
  name: string;
  description: string;
  href: string;
  Emblem: () => JSX.Element;
}

const CALLOUTS: readonly CalloutItem[] = [
  {
    name: "Safety Scores",
    description: "Report cards per coin",
    href: "/safety-scores/",
    Emblem: SafetyEmblem,
  },
  {
    name: "Yield Intelligence",
    description: "Yields, PYS-graded",
    href: "/yield/",
    Emblem: YieldEmblem,
  },
  {
    name: "Liquidity",
    description: "DEX liquidity scores",
    href: "/liquidity/",
    Emblem: LiquidityEmblem,
  },
  {
    name: "Selector",
    description: "Find your stablecoin",
    href: "/screener/selector/",
    Emblem: SelectorEmblem,
  },
  {
    name: "PharosWatchBot",
    description: "Telegram peg alerts",
    href: "/pharoswatchbot/",
    Emblem: BeaconEmblem,
  },
];

export function HomeAltCalloutStrip(): JSX.Element {
  return (
    <nav aria-label="Pharos products" className="pharos-card-shell overflow-hidden p-0">
      <ul className="flex snap-x snap-mandatory divide-x divide-border/40 overflow-x-auto sm:overflow-visible">
        {CALLOUTS.map(({ name, description, href, Emblem }) => (
          <li
            key={href}
            className="min-w-[230px] flex-shrink-0 snap-start sm:min-w-0 sm:flex-1"
          >
            <Link
              href={href}
              className="group flex h-full items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
            >
              <span
                aria-hidden="true"
                className="grid h-20 w-20 shrink-0 place-items-center rounded-md border border-border/60 bg-[color-mix(in_oklab,var(--brand-accent)_8%,transparent)] text-[var(--brand-accent)] transition-colors group-hover:border-[var(--brand-accent)]/40 group-hover:bg-[color-mix(in_oklab,var(--brand-accent)_14%,transparent)]"
              >
                <Emblem />
              </span>
              <div className="min-w-0">
                <p className="font-mono text-[11px] font-medium uppercase tracking-wider leading-tight text-foreground">
                  {name}
                </p>
                <p className="truncate text-[11px] leading-snug text-muted-foreground">
                  {description}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
