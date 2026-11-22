"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { getRouteCapabilities } from "@/lib/route-capabilities";

export function RouteChrome({ children, dataTableOnly = false }: { children: ReactNode; dataTableOnly?: boolean }) {
  const pathname = usePathname();
  const capabilities = getRouteCapabilities(pathname);
  if (capabilities.chrome !== "public") return null;
  if (dataTableOnly && !capabilities.dataAnchor) return null;
  return children;
}

export function RegimeBarChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hasRegimeBar = getRouteCapabilities(pathname).regimeBar;

  useEffect(() => {
    document.documentElement.dataset.regimeBar = hasRegimeBar ? "on" : "off";
  }, [hasRegimeBar]);

  if (!hasRegimeBar) return null;
  return children;
}

/**
 * Wraps the standard global footer. The digest section ships its own editorial
 * colophon (one-line on the archive, full provenance on each dated page), so
 * the sitemap-style site footer is suppressed across /digest.
 */
export function GlobalFooterChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { footer } = getRouteCapabilities(pathname);
  if (footer === "route") return null;
  if (footer === "home") {
    return <div className="pharos-home-footer">{children}</div>;
  }
  return children;
}

export function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { chrome, chromeless, home, regimeBar } = getRouteCapabilities(pathname);
  if (chrome === "ops") return children;
  const className = chromeless
    ? "flex-1 min-w-0"
    : home
      ? "flex-1 w-full px-4 pt-6 pb-2 md:pt-7 md:pb-3 lg:px-5 xl:px-9"
      : "pharos-mobile-utility-safe flex-1 mx-auto w-full max-w-[120rem] px-4 py-6 md:py-7 lg:px-5 xl:px-9";

  return (
    <main id="main-content" data-regime-bar={regimeBar ? "on" : "off"} className={className}>
      {children}
    </main>
  );
}
