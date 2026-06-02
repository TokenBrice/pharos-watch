"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { HomepageTape } from "@/components/homepage-tape";
import { useSidebar } from "@/components/sidebar";
import { CORE_NAV_ITEMS, isCoreNavPath, normalizeNavPath } from "@/lib/nav-config";
import { cn } from "@/lib/utils";

export function CoreTopRail() {
  const pathname = usePathname();
  const { expanded } = useSidebar();

  if (!isCoreNavPath(pathname)) return null;

  const normalizedPath = normalizeNavPath(pathname ?? "/");

  return (
    <div
      style={{
        ["--pharos-core-rail-offset" as string]: expanded
          ? "var(--sidebar-width-expanded)"
          : "var(--sidebar-width-collapsed)",
      }}
    >
      <HomepageTape placement="top" />
      <nav
        aria-label="Core pages"
        className="relative z-50 w-full overflow-x-auto overscroll-x-contain border-b border-border/70 bg-background/95 shadow-[0_1px_0_oklch(1_0_0_/0.04)] supports-[backdrop-filter]:bg-background/88"
      >
        <div className="mx-auto flex w-max min-w-full items-center justify-center gap-1 px-2 py-1.5 sm:px-3">
          {CORE_NAV_ITEMS.map((item, index) => {
            const isActive = normalizeNavPath(item.href) === normalizedPath;

            return (
              <div key={item.href} className="flex items-center gap-1">
                {index > 0 ? (
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
                ) : null}
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "pharos-focus-ring inline-flex h-8 items-center rounded-md px-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap transition-[background-color,border-color,color,box-shadow]",
                    isActive
                      ? "pharos-nav-active text-foreground"
                      : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              </div>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
