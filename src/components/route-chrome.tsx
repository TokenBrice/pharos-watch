"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function isChromelessPath(pathname: string | null): boolean {
  return pathname === "/pharoswatchbot/app" || pathname?.startsWith("/pharoswatchbot/app/") === true;
}

export function RouteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isChromelessPath(pathname)) return null;
  return children;
}

export function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const className = isChromelessPath(pathname)
    ? "flex-1 min-w-0"
    : "pharos-mobile-utility-safe flex-1 container mx-auto px-4 py-6 md:py-7 lg:px-6";

  return (
    <main id="main-content" className={className}>
      {children}
    </main>
  );
}
