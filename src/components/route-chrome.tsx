"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useSidebar } from "@/components/sidebar-context";
import { routeLabelFor } from "@/lib/route-labels";

function isChromelessPath(pathname: string | null): boolean {
  return pathname === "/pharoswatchbot/app" || pathname?.startsWith("/pharoswatchbot/app/") === true;
}

function isDigestPath(pathname: string | null): boolean {
  return pathname === "/digest" || pathname?.startsWith("/digest/") === true;
}

function CollapsedPageChip() {
  const { pinned, togglePin } = useSidebar();
  const pathname = usePathname();
  if (pinned) return null;
  const label = pathname ? routeLabelFor(pathname) : null;
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

/**
 * Wraps the standard global footer. The digest section ships its own editorial
 * colophon (one-line on the archive, full provenance on each dated page), so
 * the sitemap-style site footer is suppressed across /digest.
 */
export function GlobalFooterChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isChromelessPath(pathname) || isDigestPath(pathname)) return null;
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
