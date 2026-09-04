"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { QUICK_NAV_ITEMS } from "@/lib/nav-config";
import { openNavDrawer } from "@/lib/nav-drawer";
import { isRouteActive } from "@/lib/navigation";

const MOBILE_ROUTE_ITEMS = QUICK_NAV_ITEMS.filter((item) => item.href !== "/stability-index/");

function mobileLabel(item: (typeof MOBILE_ROUTE_ITEMS)[number]): string {
  // "DDR" is useful in the constrained desktop rail, but "Depegs" is more
  // legible as a persistent phone-nav label.
  if (item.shortLabel === "DDR") return "Depegs";
  return item.shortLabel ?? item.label;
}

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-[55] border-t border-border/70 bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <div className="grid h-[var(--mobile-bottom-nav-height)] grid-cols-5">
        {MOBILE_ROUTE_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isRouteActive(pathname, item.href);

          return (
            <Link
              key={item.href}
              prefetch={false}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "pharos-focus-ring flex min-h-11 flex-col items-center justify-center gap-1 text-frost-blue transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none"
                  : "pharos-focus-ring flex min-h-11 flex-col items-center justify-center gap-1 text-muted-foreground transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] hover:text-foreground motion-reduce:transition-none"
              }
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span className="text-[11px] font-medium leading-none">{mobileLabel(item)}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={openNavDrawer}
          className="pharos-focus-ring flex min-h-11 flex-col items-center justify-center gap-1 text-muted-foreground transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] hover:text-foreground motion-reduce:transition-none"
          aria-label="Menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span className="text-[11px] font-medium leading-none">Menu</span>
        </button>
      </div>
    </nav>
  );
}
