"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Search, SunMoon } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { ThemeControls } from "@/components/theme-controls";
import {
  DropdownMenu,
  DropdownMenuContent,
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
    state: "Healthy",
    dotClassName: "bg-[var(--severity-healthy)]",
  },
  degraded: {
    state: "Degraded",
    dotClassName: "bg-[var(--severity-mild)]",
  },
  stale: {
    state: "Stale",
    dotClassName: "bg-[var(--severity-severe)]",
  },
} as const;

const CHECKING_STATUS_MENU = {
  state: "Checking",
  dotClassName: "bg-muted-foreground/50",
} as const;

const UNAVAILABLE_STATUS_MENU = {
  state: "Unavailable",
  dotClassName: "bg-muted-foreground/50",
} as const;

/**
 * Single menu row. Section menus render the authored `description` on a second
 * line: the copy is what turns DDR, DEWS, and FreezeWatch from jargon into a
 * decision. Every description is written to fit that line at this panel width
 * (see the budget test in `nav-config.test.ts`), so a row is a fixed two-line
 * block and the panel scans as an even column. The sectioned columns drop the
 * description entirely so three columns of tail routes fit one panel.
 */
function NavMenuItem({
  item,
  isActive,
  withDescription,
  trailing,
  onNavigate,
}: {
  item: NavItem;
  isActive: boolean;
  withDescription?: boolean;
  trailing?: React.ReactNode;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const descriptionId = useId();
  const hasDescription = Boolean(withDescription && item.description);

  return (
    <li>
      <Link
        href={item.href}
        prefetch={false}
        aria-current={isActive ? "page" : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        onClick={onNavigate}
        className={cn(
          "relative flex cursor-default gap-2.5 rounded-lg px-2.5 text-sm outline-hidden select-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:text-accent-foreground",
          withDescription ? "items-start py-2" : "items-center py-2",
        )}
        {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        <Icon className={cn("size-4 shrink-0 text-muted-foreground", withDescription && "mt-0.5")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-sm font-medium text-foreground">
            {item.label}
            {item.external ? <ArrowUpRight className="size-3 text-muted-foreground/70" aria-hidden /> : null}
          </span>
          {hasDescription ? (
            <span
              id={descriptionId}
              aria-hidden="true"
              className="mt-0.5 block text-xs leading-snug text-muted-foreground"
            >
              {item.description}
            </span>
          ) : null}
        </span>
        {trailing}
      </Link>
    </li>
  );
}

/**
 * Desktop masthead nav (≥lg). A quick rail carries the four highest-traffic
 * routes as direct links, three section menus own market/risk/tool surfaces,
 * and one sectioned Resources panel holds the long tail that previously sat in
 * two top-level menus plus an unlabeled lighthouse button. Mobile keeps
 * <Header />.
 */
export function TopNav() {
  const pathname = usePathname();
  const normalizedPath = normalizeNavPath(pathname ?? "/");
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);

  // Desktop-only hover-to-open for the section disclosures, gated to
  // hover-capable + fine pointers so touch laptops keep tap-to-open. A separate
  // transient flag keeps hover panels dismissible without making click- or
  // keyboard-opened panels non-sticky.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [hoverCapable, setHoverCapable] = useState(false);
  const sectionNavRef = useRef<HTMLElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      clearTimeout(openTimer.current ?? undefined);
      clearTimeout(closeTimer.current ?? undefined);
    };
  }, []);

  const sectionMenuOpen = TOP_MENUS.some((menu) => menu.key === openMenu);
  useEffect(() => {
    if (!sectionMenuOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const activeRegion = sectionNavRef.current?.querySelector<HTMLElement>(`[data-section-menu="${openMenu}"]`);
      if (event.target instanceof Node && activeRegion?.contains(event.target)) return;
      hoverOpenRef.current = false;
      setOpenMenu(null);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [openMenu, sectionMenuOpen]);

  const cancelOpen = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openOnHover = (key: string) => {
    cancelClose();
    cancelOpen();
    if (openMenu === key) return;

    openTimer.current = setTimeout(
      () => {
        hoverOpenRef.current = true;
        setOpenMenu(key);
      },
      openMenu === null ? 250 : 100,
    );
  };
  const closeOnHover = (key: string) => {
    cancelOpen();
    cancelClose();
    if (!hoverOpenRef.current || openMenu !== key) return;

    closeTimer.current = setTimeout(() => {
      const activeRegion = sectionNavRef.current?.querySelector<HTMLElement>(`[data-section-menu="${key}"]`);
      if (activeRegion?.contains(document.activeElement)) return;
      hoverOpenRef.current = false;
      setOpenMenu(null);
    }, 250);
  };
  const activateMenu = (key: string) => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    setOpenMenu((current) => (current === key ? null : key));
  };
  const closeMenu = () => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    setOpenMenu(null);
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
                {/* Keep the in-product shorthand until there is room for both
                    full rail labels and the expanded search control. */}
                <span className="2xl:hidden">{item.shortLabel ?? item.label}</span>
                <span className="hidden 2xl:inline">{item.label}</span>
              </Link>
            );
          })}
        </span>
      </nav>

      {/* Right cluster reads menus → appearance → search, flush to the edge;
          the quick rail keeps the left for direct destinations. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <nav ref={sectionNavRef} aria-label="Sections" className="flex shrink-0 items-center gap-0.5">
          {TOP_MENUS.map((menu) => {
            const isActive = menu.items.some((item) => normalizeNavPath(item.href) === normalizedPath);
            const isSectioned = Boolean(menu.columns);
            const isOpen = openMenu === menu.key;
            const panelId = `top-nav-${menu.key}-panel`;
            return (
              <div
                key={menu.key}
                data-section-menu={menu.key}
                className="relative"
                onMouseEnter={hoverCapable ? () => openOnHover(menu.key) : undefined}
                onMouseLeave={hoverCapable ? () => closeOnHover(menu.key) : undefined}
                onBlur={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                  if (isOpen) closeMenu();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !isOpen) return;
                  event.preventDefault();
                  closeMenu();
                  event.currentTarget.querySelector<HTMLButtonElement>("[data-section-trigger]")?.focus();
                }}
              >
                <button
                  type="button"
                  data-section-trigger
                  aria-current={isActive ? "true" : undefined}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onPointerDown={() => {
                    cancelOpen();
                    hoverOpenRef.current = false;
                  }}
                  onKeyDown={() => {
                    cancelOpen();
                    hoverOpenRef.current = false;
                  }}
                  onClick={() => activateMenu(menu.key)}
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
                {isOpen ? (
                  <div id={panelId} className="absolute right-0 top-full z-50 pt-2">
                    <div
                      className={cn(
                        "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 min-w-[8rem] origin-top-right overflow-x-hidden overflow-y-auto rounded-md border shadow-md",
                        isSectioned ? "w-auto p-3" : "w-[19rem] p-1.5",
                      )}
                    >
                      {menu.columns ? (
                        <div className="flex gap-3">
                          {menu.columns.map((column) => (
                            <div key={column.key} className="min-w-[172px]">
                              <p className="pharos-kicker mb-1 px-2.5 text-muted-foreground/70">{column.label}</p>
                              <ul>
                                {column.items.map((item) => (
                                  <NavMenuItem
                                    key={item.href}
                                    item={item}
                                    isActive={normalizeNavPath(item.href) === normalizedPath}
                                    onNavigate={closeMenu}
                                    trailing={
                                      item.href === STATUS_HREF ? (
                                        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                          <span>{healthMenu.state}</span>
                                          <span
                                            className={cn("size-2 shrink-0 rounded-full", healthMenu.dotClassName)}
                                            aria-hidden
                                          />
                                        </span>
                                      ) : undefined
                                    }
                                  />
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <ul>
                          {menu.items.map((item) => (
                            <NavMenuItem
                              key={item.href}
                              item={item}
                              isActive={normalizeNavPath(item.href) === normalizedPath}
                              withDescription
                              onNavigate={closeMenu}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
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
                cancelOpen();
                cancelClose();
                hoverOpenRef.current = false;
              }}
              onKeyDown={() => {
                cancelOpen();
                cancelClose();
                hoverOpenRef.current = false;
              }}
              className="pharos-focus-ring inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <SunMoon className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-auto p-1.5"
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
          className="pharos-focus-ring inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/20 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground xl:w-[15rem] xl:justify-start xl:px-3 2xl:w-72"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="hidden xl:inline">Coin or page</span>
          <kbd className="ml-auto hidden rounded border border-border/70 bg-background px-1.5 font-mono text-[10px] text-muted-foreground xl:inline">
            ⌘K
          </kbd>
        </button>

      </div>
    </header>
  );
}
