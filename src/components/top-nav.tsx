"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Search, SunMoon } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { ThemeControls } from "@/components/theme-controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openCommandPalette } from "@/lib/command-palette";
import {
  NAV_GROUPS,
  QUICK_NAV_ITEMS,
  normalizeNavPath,
  stickyChromeTopOffsetClass,
  type NavGroup,
  type NavItem,
} from "@/lib/nav-config";
import { useHealth } from "@/hooks/api-hooks";
import { cn } from "@/lib/utils";

const TOP_MENUS: readonly NavGroup[] = NAV_GROUPS;
const MORE_MENU_KEY = "more";
const APPEARANCE_MENU_KEY = "appearance";
const STATUS_HREF = "/status/";

const HEALTH_STATUS_MENU = {
  healthy: {
    label: "Pharos is Healthy",
    dotClassName: "bg-[var(--severity-healthy)]",
  },
  degraded: {
    label: "Pharos is Degraded",
    dotClassName: "bg-[var(--severity-mild)]",
  },
  stale: {
    label: "Pharos is Stale",
    dotClassName: "bg-[var(--severity-severe)]",
  },
} as const;

const CHECKING_STATUS_MENU = {
  label: "Checking Status",
  dotClassName: "bg-muted-foreground/50",
} as const;

const UNAVAILABLE_STATUS_MENU = {
  label: "Status Unavailable",
  dotClassName: "bg-muted-foreground/50",
} as const;

/**
 * Single menu row. Section menus render the authored `description` on a second
 * line — the copy already exists in nav-config and is what turns DDR, DEWS, and
 * FreezeWatch from jargon into a decision. The `More` columns stay single-line
 * so three columns of tail routes fit one panel.
 */
function NavMenuItem({
  item,
  label,
  withDescription,
  trailing,
}: {
  item: NavItem;
  label?: string;
  withDescription?: boolean;
  trailing?: React.ReactNode;
}) {
  const Icon = item.icon;
  return (
    <DropdownMenuItem
      asChild
      className={cn(
        "gap-2.5 rounded-lg px-2.5 focus:bg-muted/60",
        withDescription ? "items-start py-2" : "items-center py-2",
      )}
    >
      <Link href={item.href} prefetch={false} {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}>
        <Icon className={cn("size-4 shrink-0 text-muted-foreground", withDescription && "mt-0.5")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-sm font-medium text-foreground">
            {label ?? item.label}
            {item.external ? <ArrowUpRight className="size-3 text-muted-foreground/70" aria-hidden /> : null}
          </span>
          {withDescription && item.description ? (
            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{item.description}</span>
          ) : null}
        </span>
        {trailing}
      </Link>
    </DropdownMenuItem>
  );
}

/**
 * Desktop masthead nav (≥lg). A quick rail carries the four highest-traffic
 * routes as direct links, three section menus own market/risk/tool surfaces,
 * and one sectioned `More` panel holds the long tail that previously sat in
 * two top-level menus plus an unlabeled lighthouse button. Mobile keeps
 * <Header />.
 */
export function TopNav() {
  const pathname = usePathname();
  const normalizedPath = normalizeNavPath(pathname ?? "/");
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);

  // Desktop-only hover-to-open for the section menus. Radix DropdownMenu is
  // click/keyboard-driven; we control `open` per menu and layer hover on top,
  // gated to hover-capable + fine pointers so touch laptops keep tap-to-open.
  // `modal={false}` keeps the page interactive (no scroll/pointer lock) while
  // sweeping across triggers; the focus-guard refs stop hover from stealing
  // focus while leaving keyboard activation untouched.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [hoverCapable, setHoverCapable] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpenRef = useRef(false);
  // Health stays gated to the open panel: a persistent masthead dot would add
  // /api/health polling to every desktop page view.
  const moreMenuOpen = openMenu === MORE_MENU_KEY;
  const { data: healthData, isError: healthError } = useHealth({ enabled: moreMenuOpen });
  const healthMenu = healthData
    ? HEALTH_STATUS_MENU[healthData.status]
    : healthError
      ? UNAVAILABLE_STATUS_MENU
      : CHECKING_STATUS_MENU;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHoverCapable(window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    return () => {
      clearTimeout(closeTimer.current ?? undefined);
    };
  }, []);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openOnHover = (key: string) => {
    cancelClose();
    hoverOpenRef.current = true;
    setOpenMenu(key);
  };
  const closeOnHover = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenMenu(null), 150);
  };

  return (
    <header
      aria-label="Primary"
      className={cn(
        "sticky z-50 hidden h-14 w-full items-center gap-2 border-b border-border/70 bg-background/85 px-4 backdrop-blur-md lg:flex xl:px-6",
        topOffsetClass,
      )}
    >
      <Link
        href="/"
        prefetch={false}
        className="pharos-focus-ring flex shrink-0 items-center gap-2.5 rounded-lg pr-2"
        aria-label="Pharos home"
      >
        <PharosLogo size={28} className="rounded-full shadow-sm" priority />
        <span className="pharos-display text-[15px] font-bold tracking-tight text-foreground">Pharos</span>
      </Link>

      {/* Destinations sit left of the fold; browsing sits on the right, next to
          search — one direction for "go", one for "explore". */}
      <nav aria-label="Quick links" className="flex shrink-0 items-center gap-0.5">
        <span className="flex items-center gap-0.5 rounded-lg bg-muted/35 p-0.5">
          {QUICK_NAV_ITEMS.map((item) => {
            const isActive = normalizeNavPath(item.href) === normalizedPath;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "pharos-focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-semibold whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {/* The icon is the affordance that separates a direct link from
                    a menu trigger; triggers carry a chevron and no glyph. */}
                <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                {/* Prefer descriptive route names once the rail has room. The
                    search control stays icon-only at xl so these labels can
                    expand without pushing the right edge out of view. */}
                <span className="xl:hidden">{item.shortLabel ?? item.label}</span>
                <span className="hidden xl:inline">{item.label}</span>
              </Link>
            );
          })}
        </span>
      </nav>

      {/* Right cluster reads menus → appearance → search, flush to the edge;
          the quick rail keeps the left for direct destinations. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <nav aria-label="Sections" className="flex shrink-0 items-center gap-0.5">
        {TOP_MENUS.map((menu) => {
          const isActive = menu.items.some((item) => normalizeNavPath(item.href) === normalizedPath);
          const isSectioned = Boolean(menu.columns);
          return (
            <DropdownMenu
              key={menu.key}
              modal={false}
              open={openMenu === menu.key}
              onOpenChange={(next) => {
                cancelClose();
                setOpenMenu(next ? menu.key : null);
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  onPointerDown={() => {
                    hoverOpenRef.current = false;
                  }}
                  onKeyDown={() => {
                    hoverOpenRef.current = false;
                  }}
                  onMouseEnter={hoverCapable ? () => openOnHover(menu.key) : undefined}
                  onMouseLeave={hoverCapable ? closeOnHover : undefined}
                  className={cn(
                    "pharos-focus-ring inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors",
                    isActive
                      ? "bg-muted/60 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {menu.label}
                  <ChevronDown className="size-3 opacity-50" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className={cn("p-1.5", isSectioned ? "w-auto p-3" : "w-[19rem]")}
                onMouseEnter={hoverCapable ? cancelClose : undefined}
                onMouseLeave={hoverCapable ? closeOnHover : undefined}
                onCloseAutoFocus={(event) => {
                  if (hoverOpenRef.current) event.preventDefault();
                }}
              >
                {menu.columns ? (
                  <div className="flex gap-3">
                    {menu.columns.map((column) => (
                      <div key={column.key} className="min-w-[172px]">
                        <p className="pharos-kicker mb-1 px-2.5 text-muted-foreground/70">{column.label}</p>
                        {column.items.map((item) =>
                          item.href === STATUS_HREF ? (
                            <NavMenuItem
                              key={item.href}
                              item={item}
                              label={healthMenu.label}
                              trailing={
                                <span className={cn("ml-auto size-2 shrink-0 rounded-full", healthMenu.dotClassName)} aria-hidden />
                              }
                            />
                          ) : (
                            <NavMenuItem key={item.href} item={item} />
                          ),
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  menu.items.map((item) => <NavMenuItem key={item.href} item={item} withDescription />)
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
        </nav>
        <DropdownMenu
          modal={false}
          open={openMenu === APPEARANCE_MENU_KEY}
          onOpenChange={(next) => {
            cancelClose();
            setOpenMenu(next ? APPEARANCE_MENU_KEY : null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Appearance"
              onPointerDown={() => {
                hoverOpenRef.current = false;
              }}
              onKeyDown={() => {
                hoverOpenRef.current = false;
              }}
              onMouseEnter={hoverCapable ? () => openOnHover(APPEARANCE_MENU_KEY) : undefined}
              onMouseLeave={hoverCapable ? closeOnHover : undefined}
              className="pharos-focus-ring inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <SunMoon className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-auto p-1.5"
            onMouseEnter={hoverCapable ? cancelClose : undefined}
            onMouseLeave={hoverCapable ? closeOnHover : undefined}
            onCloseAutoFocus={(event) => {
              if (hoverOpenRef.current) event.preventDefault();
            }}
          >
            <ThemeControls density="desktop" />
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Search"
          className="pharos-focus-ring inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/20 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground 2xl:w-72 2xl:justify-start 2xl:px-3"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          {/* The icon carries search until there is room for both the complete
              route names and the expanded command-palette control. */}
          <span className="hidden 2xl:inline">Search</span>
          <kbd className="ml-auto hidden rounded border border-border/70 bg-background px-1.5 font-mono text-[10px] text-muted-foreground 2xl:inline">
            ⌘K
          </kbd>
        </button>

      </div>
    </header>
  );
}
