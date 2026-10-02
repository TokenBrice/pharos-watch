"use client";

import { usePathname } from "next/navigation";
import { HomepageTape } from "@/components/homepage-tape";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isChromelessPath } from "@/lib/chromeless-routes";

// The horizontal core-nav pills were retired with the top-nav redesign. This
// strip keeps just the live events tape beneath the nav, scrolling away with
// the page while only the nav stays pinned: desktop-wide, but homepage-only on
// mobile so interior routes keep their first viewport.
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

  // `relative z-40` keeps the tape's own z-50 inside this stacking context so
  // the top nav's z-50 menus still paint over it.
  return (
    <div className={`${mobileDisplayClass} lg:relative lg:z-40 lg:block`}>
      <HomepageTape placement="top" />
    </div>
  );
}
