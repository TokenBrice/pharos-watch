"use client";

import { usePathname } from "next/navigation";
import { HomepageTape } from "@/components/homepage-tape";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isChromelessPath } from "@/lib/chromeless-routes";

// The horizontal core-nav pills were retired with the top-nav redesign. This
// sticky strip keeps just the live events tape beneath the nav: desktop-wide,
// but homepage-only on mobile so interior routes keep their first viewport.
export function CoreTopRail() {
  const pathname = usePathname();
  // Treat the server snapshot as mobile so static interior HTML reserves the
  // desktop rail without mounting its data queries on narrow clients.
  const isBelowDesktop = useIsMobile(1024, true);

  if (isChromelessPath(pathname)) return null;
  if (pathname !== "/" && isBelowDesktop) {
    return <div data-testid="core-top-rail-placeholder" aria-hidden="true" className="hidden min-h-[46px] lg:block" />;
  }
  const mobileDisplayClass = pathname === "/" ? "contents" : "hidden";
  const topOffsetClass = pathname === "/" ? "lg:top-14" : "lg:top-[calc(3px+3.5rem)]";

  return (
    <div className={`${mobileDisplayClass} lg:sticky lg:z-40 lg:block ${topOffsetClass}`}>
      <HomepageTape placement="top" />
    </div>
  );
}
