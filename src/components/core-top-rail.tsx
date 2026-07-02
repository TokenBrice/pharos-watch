"use client";

import { usePathname } from "next/navigation";
import { HomepageTape } from "@/components/homepage-tape";
import { isChromelessPath } from "@/lib/chromeless-routes";

// The horizontal core-nav pills were retired with the top-nav redesign. This
// sticky strip keeps just the live events tape beneath the nav: desktop-wide,
// but homepage-only on mobile so interior routes keep their first viewport.
export function CoreTopRail() {
  const pathname = usePathname();

  if (isChromelessPath(pathname)) return null;
  const mobileDisplayClass = pathname === "/" ? "contents" : "hidden";
  const topOffsetClass = pathname === "/" ? "lg:top-14" : "lg:top-[calc(3px+3.5rem)]";

  return (
    <div className={`${mobileDisplayClass} lg:sticky lg:z-40 lg:block ${topOffsetClass}`}>
      <HomepageTape placement="top" />
    </div>
  );
}
