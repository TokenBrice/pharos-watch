"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { scheduleIdle } from "@/lib/browser-utils";
import { getRouteCapabilities } from "@/lib/route-capabilities";

// Keep tape queries, logos and event formatting outside the eager root shell.
const HomepageTape = dynamic(
  () => import("@/components/homepage/homepage-tape").then((mod) => mod.HomepageTape),
  { loading: () => null },
);

// The tape scrolls away while navigation stays pinned. Editorial routes retain
// the same desktop rail, but load its live presentation after document load
// and an idle opportunity, never ahead of their main text.
export function CoreTopRail() {
  const pathname = usePathname();
  const isBelowDesktop = useIsMobile(1024, true);
  const [readyEditorialPath, setReadyEditorialPath] = useState<string | null>(null);
  const { editorial, chromeless, home } = getRouteCapabilities(pathname);

  useEffect(() => {
    if (!editorial || chromeless || isBelowDesktop) return;
    let cancelIdle: (() => void) | undefined;
    const afterLoad = () => {
      cancelIdle = scheduleIdle(() => setReadyEditorialPath(pathname), { timeoutMs: 2000, fallbackDelayMs: 2000 });
    };
    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });
    return () => {
      window.removeEventListener("load", afterLoad);
      cancelIdle?.();
    };
  }, [pathname, editorial, chromeless, isBelowDesktop]);

  if (chromeless) return null;
  if (!home && isBelowDesktop) {
    return <div data-testid="core-top-rail-placeholder" aria-hidden="true" className="hidden min-h-10 lg:block" />;
  }
  const ready = !editorial || readyEditorialPath === pathname;

  return (
    <div className={home ? "min-h-10" : "hidden min-h-10 lg:block"}>
      {ready ? <HomepageTape placement="top" /> : null}
    </div>
  );
}
