"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useSidebar } from "@/components/sidebar";

function isChromelessPath(pathname: string | null): boolean {
  return pathname === "/pharoswatchbot/app" || pathname?.startsWith("/pharoswatchbot/app/") === true;
}

const ROUTE_LABELS: Record<string, string> = {
  "/": "Dashboard",
  "/stability-index": "Stability Index",
  "/safety-scores": "Safety Scores",
  "/yield": "Yield Intelligence",
  "/alt-pegs": "Alt-Pegs",
  "/freezewatch": "FreezeWatch",
  "/pharoswatchbot": "PharosWatchBot",
  "/liquidity": "Liquidity",
  "/depeg": "Depeg",
  "/flows": "Mint/Burn Flows",
  "/chains": "Chains",
  "/cemetery": "Cemetery",
  "/screener": "Screener",
  "/dependency-map": "Dependency Map",
  "/portfolio": "Portfolio Audit",
  "/compare": "Compare",
  "/timeline": "Timeline",
  "/upcoming": "Upcoming",
  "/digest": "Digest",
  "/status": "Pharos Status",
  "/about": "About",
  "/funding": "Funding",
  "/methodology": "Methodology",
  "/learn/mechanisms": "Mechanisms",
  "/coverage": "Coverage",
  "/api": "API Access",
  "/changelog": "Changelog",
  "/start": "Start Here",
  "/stablecoin": "Stablecoin",
  "/stablecoins": "Stablecoins",
};

function titleCaseSegment(segment: string): string {
  return segment
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function routeLabelFor(pathname: string | null): string | null {
  if (!pathname || pathname === "/") return ROUTE_LABELS["/"] ?? null;
  const direct = ROUTE_LABELS[pathname];
  if (direct) return direct;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const root = `/${segments[0]}`;
  if (ROUTE_LABELS[root]) return ROUTE_LABELS[root];
  return titleCaseSegment(segments[0]);
}

function CollapsedPageChip() {
  const { pinned, togglePin } = useSidebar();
  const pathname = usePathname();
  if (pinned) return null;
  const label = routeLabelFor(pathname);
  if (!label) return null;
  return (
    <div className="hidden lg:flex justify-start -mt-3 mb-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
      <button
        type="button"
        onClick={togglePin}
        aria-label={`You are on ${label}. Expand sidebar`}
        title="Expand sidebar"
        className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-background/30 px-2.5 py-0.5 font-mono text-[var(--text-3xs)] uppercase tracking-[0.16em] text-muted-foreground/70 transition-[background-color,color,border-color] duration-150 hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground"
      >
        <span>Pharos</span>
        <span aria-hidden="true">·</span>
        <span className="text-muted-foreground">{label}</span>
      </button>
    </div>
  );
}

export function RouteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isChromelessPath(pathname)) return null;
  return children;
}

export function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const chromeless = isChromelessPath(pathname);
  const className = chromeless
    ? "flex-1 min-w-0"
    : "pharos-mobile-utility-safe flex-1 container mx-auto px-4 py-6 md:py-7 lg:px-6";

  return (
    <main id="main-content" className={className}>
      {!chromeless && <CollapsedPageChip />}
      {children}
    </main>
  );
}
