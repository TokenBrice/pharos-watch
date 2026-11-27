"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import { trackEvent } from "@/lib/analytics";
import { QUICK_NAV_ITEMS, isNavItemActive } from "@/lib/nav-config";
import { openNavDrawer, useNavDrawerOpen } from "@/lib/nav-drawer";
import { getRouteCapabilities } from "@/lib/route-capabilities";

// Four route slots plus Menu fill the five-column bar; the remaining rail
// items (Stability, FreezeWatch) stay one tap away in the drawer's pinned monitors.
const MOBILE_ROUTE_ITEMS = QUICK_NAV_ITEMS.filter((item) => getRouteCapabilities(item.href).mobileBottomNav);

export function MobileBottomNav() {
  const pathname = usePathname();
  // Recent/escalating open-incident badge matching the desktop rail (Decision D):
  // omitted at zero recent or when split counts are unavailable so it never flaps.
  const incidentsData = useHomepageSnapshot().data?.incidents.data ?? null;
  const hasIncidentSplit =
    incidentsData != null
    && incidentsData.recentActiveDepegCount != null
    && incidentsData.longRunningActiveDepegCount != null
    && incidentsData.recentActiveDepegCount + incidentsData.longRunningActiveDepegCount === incidentsData.activeDepegCount;
  const recentDepegCount = hasIncidentSplit ? incidentsData.recentActiveDepegCount! : null;
  const longRunningDepegCount = hasIncidentSplit ? incidentsData.longRunningActiveDepegCount! : null;
  const depegSrText = !hasIncidentSplit
    ? null
    : recentDepegCount! > 0
      ? longRunningDepegCount! > 0
        ? `, ${recentDepegCount} recent ${recentDepegCount === 1 ? "depeg" : "depegs"}, ${longRunningDepegCount} long-running`
        : `, ${recentDepegCount} recent ${recentDepegCount === 1 ? "depeg" : "depegs"}`
      : longRunningDepegCount! > 0
        ? `, 0 recent, ${longRunningDepegCount} long-running active ${longRunningDepegCount === 1 ? "depeg" : "depegs"}`
        : null;
  const drawerOpen = useNavDrawerOpen();
  const isBottomRouteActive = MOBILE_ROUTE_ITEMS.some((item) => isNavItemActive(pathname, item));
  const menuActive = drawerOpen || !isBottomRouteActive;

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-chrome-dock border-t border-border/70 bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <div className="mx-auto grid h-[var(--mobile-bottom-nav-height)] max-w-xl grid-cols-5">
        {MOBILE_ROUTE_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isNavItemActive(pathname, item);
          const isDepeg = item.href === "/depeg/";
          const badge = isDepeg && recentDepegCount && recentDepegCount > 0 ? recentDepegCount : null;

          return (
            <Link
              key={item.href}
              prefetch={false}
              href={item.href}
              onClick={() => {
                trackEvent("nav_click", { surface: "bottom_bar", group: "rail", href: item.href });
              }}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "pharos-focus-ring relative flex min-h-11 flex-col items-center justify-center gap-1 text-brand-accent-text transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none"
                  : "pharos-focus-ring relative flex min-h-11 flex-col items-center justify-center gap-1 text-muted-foreground transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] hover:text-foreground motion-reduce:transition-none"
              }
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 top-0 h-0.5 rounded-b-full bg-brand-accent-text"
                />
              ) : null}
              <span className="relative">
                <Icon className="h-5 w-5" aria-hidden="true" />
                {badge ? (
                  <span
                    aria-hidden="true"
                    className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-muted px-1 text-center font-mono text-3xs font-semibold leading-4 tabular-nums text-foreground ring-2 ring-background"
                  >
                    {badge}
                  </span>
                ) : null}
              </span>
              <span className={active ? "text-2xs font-semibold leading-none" : "text-2xs font-medium leading-none"}>
                {item.shortLabel ?? item.label}
              </span>
              {isDepeg && depegSrText ? <span className="sr-only">{depegSrText}</span> : null}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={openNavDrawer}
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          className={
            menuActive
              ? "pharos-focus-ring relative flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 text-brand-accent-text transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none"
              : "pharos-focus-ring relative flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 text-muted-foreground transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] hover:text-foreground motion-reduce:transition-none"
          }
          aria-label="Menu"
        >
          {menuActive ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-3 top-0 h-0.5 rounded-b-full bg-brand-accent-text"
            />
          ) : null}
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span className={menuActive ? "text-2xs font-semibold leading-none" : "text-2xs font-medium leading-none"}>
            Menu
          </span>
        </button>
      </div>
    </nav>
  );
}
