"use client";

import { usePathname } from "next/navigation";
import { HomepageTape } from "@/components/homepage-tape";
import { isCoreNavPath } from "@/lib/nav-config";

function isChromelessPath(pathname: string | null): boolean {
  return pathname === "/pharoswatchbot/app" || pathname?.startsWith("/pharoswatchbot/app/") === true;
}

// The horizontal core-nav pills were retired with the top-nav redesign — the
// Terminal dropdown now carries the same destinations, so the pill rail was
// redundant. This sticky strip keeps just the live events tape beneath the nav.
export function CoreTopRail() {
  const pathname = usePathname();

  if (isChromelessPath(pathname)) return null;
  const mobileDisplayClass = isCoreNavPath(pathname) ? "contents" : "hidden";
  const topOffsetClass = pathname === "/" ? "lg:top-14" : "lg:top-[calc(3px+3.5rem)]";

  return (
    <div className={`${mobileDisplayClass} lg:sticky lg:z-40 lg:block ${topOffsetClass}`}>
      <HomepageTape placement="top" />
    </div>
  );
}
