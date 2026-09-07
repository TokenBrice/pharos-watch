"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isOpsPath } from "@/lib/admin-workspaces";
import { isChromelessPath } from "@/lib/chromeless-routes";

function isDigestPath(pathname: string | null): boolean {
  return pathname === "/digest" || pathname?.startsWith("/digest/") === true;
}

// Exact public workspaces whose content owns the focusable #data target.
const DATA_TABLE_PATHS = new Set([
  "/", "/liquidity", "/screener", "/flows", "/timeline", "/safety-scores",
  "/freezewatch", "/depeg", "/compliance", "/yield",
]);

export function RouteChrome({ children, dataTableOnly = false }: { children: ReactNode; dataTableOnly?: boolean }) {
  const pathname = usePathname();
  if (isChromelessPath(pathname) || isOpsPath(pathname)) return null;
  if (dataTableOnly && (!pathname || !DATA_TABLE_PATHS.has(pathname.replace(/\/$/, "") || "/"))) return null;
  return children;
}

export function RegimeBarChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isChromelessPath(pathname) || isOpsPath(pathname) || pathname === "/") return null;
  return children;
}

/**
 * Wraps the standard global footer. The digest section ships its own editorial
 * colophon (one-line on the archive, full provenance on each dated page), so
 * the sitemap-style site footer is suppressed across /digest.
 */
export function GlobalFooterChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isChromelessPath(pathname) || isOpsPath(pathname) || isDigestPath(pathname)) return null;
  if (pathname === "/") {
    return <div className="pharos-home-footer">{children}</div>;
  }
  return children;
}

export function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isOpsPath(pathname)) return children;

  const chromeless = isChromelessPath(pathname);
  const className = chromeless
    ? "flex-1 min-w-0"
    : pathname === "/"
      ? "flex-1 w-full px-4 pt-6 pb-2 md:pt-7 md:pb-3 lg:px-5 xl:px-9"
      : "pharos-mobile-utility-safe flex-1 mx-auto w-full max-w-[120rem] px-4 py-6 md:py-7 lg:px-5 xl:px-9";

  return (
    <main id="main-content" className={className}>
      {children}
    </main>
  );
}
