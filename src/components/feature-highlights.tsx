"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  Droplets,
  FlaskConical,
  Network,
  ScrollText,
  ShieldBan,
  ShieldAlert,
  Skull,
  TrendingUp,
  Wallet,
} from "lucide-react";

const FEATURES = [
  {
    title: "DEX Liquidity",
    description: "Pool-level liquidity scores across every tracked stablecoin.",
    href: "/liquidity",
    icon: Droplets,
    borderClass: "border-l-cyan-500",
    linkLabel: "View rankings",
  },
  {
    title: "Safety Scores",
    description: "Composite safety grades: peg stability, liquidity & risk factors.",
    href: "/safety-scores",
    icon: FlaskConical,
    borderClass: "border-l-amber-500",
    linkLabel: "View grades",
  },
  {
    title: "Blacklist Tracker",
    description: "On-chain freeze & destroy events across issuer blacklists.",
    href: "/blacklist",
    icon: ShieldBan,
    borderClass: "border-l-red-500",
    linkLabel: "View events",
  },
  {
    title: "Stability Index",
    description: "Market-wide peg health signal updated every 15 minutes.",
    href: "/stability-index",
    icon: Activity,
    borderClass: "border-l-teal-500",
    linkLabel: "View history",
  },
  {
    title: "Stablecoin Cemetery",
    description: "Dead stablecoins and what killed them.",
    href: "/cemetery",
    icon: Skull,
    borderClass: "border-l-zinc-500",
    linkLabel: "View all",
  },
  {
    title: "Digest Archive",
    description: "AI-generated daily market recaps with data snapshots.",
    href: "/digest/",
    icon: ScrollText,
    borderClass: "border-l-violet-500",
    linkLabel: "View archive",
  },
  {
    title: "Dependency Map",
    description: "Collateral dependency graph across the stablecoin ecosystem.",
    href: "/dependency-map",
    icon: Network,
    borderClass: "border-l-indigo-500",
    linkLabel: "View map",
  },
  {
    title: "Portfolio",
    description: "Personal stablecoin risk view with stress-test scenarios.",
    href: "/portfolio",
    icon: Wallet,
    borderClass: "border-l-emerald-500",
    linkLabel: "Build portfolio",
  },
  {
    title: "Compare",
    description: "Side-by-side stablecoin comparison on every metric.",
    href: "/compare",
    icon: ArrowLeftRight,
    borderClass: "border-l-sky-500",
    linkLabel: "Compare coins",
  },
  {
    title: "Depeg Tracker",
    description: "Live peg deviations, early warning scores, and depeg event history.",
    href: "/depeg",
    icon: ShieldAlert,
    borderClass: "border-l-rose-500",
    linkLabel: "View tracker",
  },
  {
    title: "Mint & Burn Flows",
    description: "On-chain mint/burn activity with flow intensity and bank run gauge.",
    href: "/flows",
    icon: ArrowUpDown,
    borderClass: "border-l-blue-500",
    linkLabel: "View flows",
  },
  {
    title: "Yield Intelligence",
    description: "APY rankings with safety-adjusted scores and warning signals.",
    href: "/yield",
    icon: TrendingUp,
    borderClass: "border-l-green-500",
    linkLabel: "View yields",
  },
];

const DISPLAY_COUNT = 6;

export function FeatureHighlights() {
  const selected = useMemo(() => FEATURES.slice(0, DISPLAY_COUNT), []);

  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight mb-4">Explore</h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
        {selected.map((f) => (
          <Link
            key={f.href}
            href={f.href}
            className={`group rounded-xl border border-border/50 border-l-[3px] ${f.borderClass} p-4 flex flex-col gap-1.5 transition-colors hover:bg-muted/40`}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <f.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {f.title}
            </span>
            <span className="text-xs text-muted-foreground leading-relaxed">
              {f.description}
            </span>
            <span className="mt-auto pt-1 text-xs text-muted-foreground/70 group-hover:text-foreground transition-colors">
              {f.linkLabel} &rarr;
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
