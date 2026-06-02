"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { HomepageTape } from "@/components/homepage-tape";
import { useSidebar } from "@/components/sidebar";
import { CORE_NAV_ITEMS, isCoreNavPath, normalizeNavPath } from "@/lib/nav-config";
import { cn } from "@/lib/utils";

export function CoreTopRail() {
  const pathname = usePathname();
  const { expanded } = useSidebar();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  const normalizedPath = normalizeNavPath(pathname ?? "/");

  // Keep the lit pill in view: center it on mount and whenever the route
  // changes so the active anchor never scrolls off-screen with no affordance.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
  }, [normalizedPath]);

  if (!isCoreNavPath(pathname)) return null;

  return (
    <div
      style={{
        ["--pharos-core-rail-offset" as string]: expanded
          ? "var(--sidebar-width-expanded)"
          : "var(--sidebar-width-collapsed)",
      }}
      className="lg:sticky lg:top-[3px] lg:z-50"
    >
      <HomepageTape placement="top" />
      <nav
        aria-label="Core pages"
        className="pharos-rail-ground sticky top-[3px] z-[55] w-full border-b border-border/70 shadow-[0_1px_0_oklch(1_0_0_/0.04)] lg:relative lg:top-auto lg:z-50"
      >
        <div className="overflow-x-auto overscroll-x-contain">
          <div className="mx-auto flex w-max min-w-full items-center justify-center [justify-content:safe_center] gap-1 px-2 py-2 sm:px-3 sm:py-1.5">
            {CORE_NAV_ITEMS.map((item, index) => {
              const isActive = normalizeNavPath(item.href) === normalizedPath;
              const Icon = item.icon;

              return (
                <Fragment key={item.href}>
                  {index > 0 && (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45"
                    />
                  )}
                  <Link
                    ref={isActive ? activeRef : undefined}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "pharos-rail-tab pharos-focus-ring relative isolate inline-flex min-h-11 items-center gap-1.5 overflow-hidden rounded-md px-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap sm:min-h-8",
                      isActive && "pharos-rail-tab-active",
                    )}
                  >
                    {isActive ? <span aria-hidden className="pharos-nav-beam" /> : null}
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        isActive ? "text-frost-blue" : "text-muted-foreground/80",
                      )}
                    />
                    {item.label}
                  </Link>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent"
        />
      </nav>
    </div>
  );
}
