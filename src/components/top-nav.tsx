"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Search, SunMoon } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import { useHydrated } from "@/hooks/use-hydrated";
import { RegimeBarToggle } from "@/components/psi-beacon/regime-bar";
import { ThemeControls } from "@/components/theme-controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openCommandPalette } from "@/lib/command-palette";
import { trackEvent } from "@/lib/analytics";
import { getRouteCapabilities } from "@/lib/route-capabilities";
import {
  NAV_GROUPS,
  QUICK_NAV_ITEMS,
  isNavItemActive,
  stickyChromeTopOffsetClass,
  type NavGroup,
  type NavItem,
} from "@/lib/nav-config";
import { cn } from "@/lib/utils";

const TOP_MENUS: readonly NavGroup[] = NAV_GROUPS;
const APPEARANCE_MENU_KEY = "appearance";
const HOVER_CLOSE_DELAY_MS = 450;

function openKeyboardShortcuts(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true }));
}

/**
 * Single menu row. `row` renders the authored `description` on a second line
 * beside an icon tile: the copy is what turns DDR, DEWS, and FreezeWatch from
 * jargon into a decision, and every description is written to fit that line
 * at this panel width, so a row is a fixed two-line block and the panel scans
 * as an even column. `compact` is the plain-link tier for destinations people
 * already know by name; its description moves to the tooltip.
 */
function NavMenuItem({
  item,
  group,
  isActive,
  variant,
  onNavigate,
}: {
  item: NavItem;
  group: string;
  isActive: boolean;
  variant: "row" | "compact";
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const descriptionId = useId();
  const isRow = variant === "row";
  const hasDescription = Boolean(isRow && item.description);

  return (
    <li>
      <Link
        href={item.href}
        prefetch={false}
        aria-current={isActive ? "page" : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        title={isRow ? undefined : item.description}
        onClick={() => {
          trackEvent("nav_click", { surface: "menu", group, href: item.href });
          onNavigate();
        }}
        className={cn(
          "group/nav-item relative flex cursor-default items-center rounded-lg text-sm outline-hidden select-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:text-accent-foreground",
          isRow ? "gap-3 px-2 py-1.5" : "h-8 gap-2 px-2",
          isActive && "bg-muted/60 ring-1 ring-border/60 dark:bg-card dark:ring-border/80",
        )}
        {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {isRow ? (
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md border transition-colors group-hover/nav-item:border-border group-hover/nav-item:text-foreground",
              isActive
                ? "border-border bg-background text-foreground"
                : "border-border/50 bg-muted/40 text-muted-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "flex items-center gap-1 text-sm text-foreground",
              isRow ? "font-medium" : "text-foreground/85 group-hover/nav-item:text-foreground",
            )}
          >
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
      </Link>
    </li>
  );
}

/**
 * Desktop masthead nav (≥lg). A quick rail carries the six highest-traffic
 * routes as direct links; four section menus (Markets, Risk, Tools, Learn)
 * share one panel grammar of described rows, and Learn closes on a compact
 * About Pharos tier. Mobile keeps <Header />.
 */
export function TopNav() {
  const pathname = usePathname();
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);
  const isEditorialRoute = getRouteCapabilities(pathname).editorial;
  const hydrated = useHydrated();
  const isApplePlatform =
    hydrated && typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const searchShortcutLabel = isApplePlatform ? "⌘K" : "Ctrl K";
  // Neutral count of open confirmed incidents on the Depeg item: the compact
  // snapshot's incidents lane (the /depeg/ census), absent while unavailable.
  const activeDepegCount = useHomepageSnapshot().data?.incidents.data?.activeDepegCount ?? null;

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
  // Set when ArrowDown opens a closed trigger: the panel's rows are inert
  // until the open state commits, so the first-row focus lands in an effect.
  const pendingKeyboardOpen = useRef<string | null>(null);

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

  // ArrowDown can open a panel whose rows are still inert; land focus on the
  // first row once that menu's open state has actually committed.
  useEffect(() => {
    const key = pendingKeyboardOpen.current;
    if (!key) return;
    pendingKeyboardOpen.current = null;
    if (openMenu !== key) return;
    sectionNavRef.current?.querySelector<HTMLElement>(`[data-section-menu="${key}"] a[href]`)?.focus();
  }, [openMenu]);

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

    // Opening from closed waits longer than switching: a stray sweep across
    // the bar should not flash panels (NN/g hover-intent guidance).
    openTimer.current = setTimeout(
      () => {
        hoverOpenRef.current = true;
        setOpenMenu(key);
      },
      openMenu === null ? 350 : 100,
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
    }, HOVER_CLOSE_DELAY_MS);
  };
  const activateMenu = (key: string) => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    setOpenMenu((current) => (current === key ? null : key));
  };
  // Keyboard opens are pinned like clicks and never toggle: ArrowDown on a
  // closed trigger means "open", and the same key then roves the rows.
  const openPinned = (key: string) => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    setOpenMenu(key);
  };
  const closeMenu = () => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    setOpenMenu(null);
  };

  // A hover-opened panel must be dismissible without moving the pointer
  // (WCAG 1.4.13). The wrapper's onKeyDown only hears Esc while focus is
  // inside the menu, so listen on the document when focus is elsewhere.
  useEffect(() => {
    if (!openMenu || openMenu === APPEARANCE_MENU_KEY) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const region = sectionNavRef.current?.querySelector<HTMLElement>(`[data-section-menu="${openMenu}"]`);
      if (region?.contains(document.activeElement)) return;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      if (openTimer.current) clearTimeout(openTimer.current);
      hoverOpenRef.current = false;
      setOpenMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openMenu]);

  // z-chrome-header, like the mobile Header: page-level sticky bars (the
  // profile section tabs, the methodology scrollspy) sit on z-chrome and
  // scroll beneath the nav, so an open nav panel is never covered.
  return (
    <header
      aria-label="Primary"
      className={cn(
        "sticky z-chrome-header hidden h-14 w-full items-center gap-2 border-b border-border/70 bg-background/85 px-4 backdrop-blur-md lg:flex min-[1440px]:px-6",
        topOffsetClass,
      )}
    >
      <Link
        href="/"
        prefetch={false}
        className="pharos-focus-ring flex shrink-0 items-center gap-2 rounded-lg pr-1 min-[1440px]:gap-2.5 min-[1440px]:pr-2"
        aria-label="Pharos home"
      >
        <PharosLogo size={28} className="rounded-full shadow-sm" priority />
        {/* Wordmark waits for xl: at lg the mark alone carries the brand so the
            rail, section menus, PSI toggle and search fit 1024px (measured
            2026-10-22 with a classic scrollbar). */}
        <span className="pharos-display hidden text-sm font-bold tracking-tight text-foreground xl:inline">Pharos</span>
      </Link>

      {/* Destinations sit left of the fold; browsing sits on the right, next to
          search: one direction for "go", one for "explore". */}
      <nav aria-label="Quick links" className="flex shrink-0 items-center gap-0.5">
        <span className="flex items-center gap-0 rounded-lg bg-muted/35 p-0.5 min-[1440px]:gap-0.5">
          {QUICK_NAV_ITEMS.map((item) => {
            const isActive = isNavItemActive(pathname, item);
            const Icon = item.icon;
            const badge = item.href === "/depeg/" && activeDepegCount ? activeDepegCount : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
                title={item.description}
                onClick={() => trackEvent("nav_click", { surface: "rail", group: "rail", href: item.href })}
                className={cn(
                  "pharos-focus-ring inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-sm font-semibold whitespace-nowrap transition-colors min-[1440px]:gap-1.5 min-[1440px]:px-2.5",
                  isActive
                    ? "bg-background text-foreground ring-1 ring-border/70 dark:bg-card dark:ring-1 dark:ring-border/80"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {/* The icon is the affordance that separates a direct link from
                    a menu trigger; triggers carry a chevron and no glyph. */}
                <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                {/* Three label tiers keep six items inside the masthead next to
                    the menus and search: compact below 1280px (xl:), short
                    ("Stability", "FreezeWatch") from 1280px to 1679px,
                    canonical from 1680px. */}
                <span className="xl:hidden">{item.compactLabel ?? item.shortLabel ?? item.label}</span>
                <span className="hidden xl:inline min-[1680px]:hidden">{item.shortLabel ?? item.label}</span>
                <span className="hidden min-[1680px]:inline">{item.label}</span>
                {/* A 16px glyph is too small to carry a count; it reads as a neutral pill after the label. */}
                {badge ? (
                  <span
                    aria-hidden="true"
                    className="rounded-full bg-muted px-1.5 py-px font-mono text-2xs font-semibold leading-none tabular-nums text-muted-foreground"
                  >
                    {badge}
                  </span>
                ) : null}
                {badge ? <span className="sr-only">{`, ${badge} active ${badge === 1 ? "depeg" : "depegs"}`}</span> : null}
              </Link>
            );
          })}
        </span>
      </nav>

      {/* Right cluster reads menus -> divider -> PSI -> shortcuts -> appearance -> search. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 min-[1440px]:gap-2">
        <nav ref={sectionNavRef} aria-label="Sections" className="flex shrink-0 items-center gap-0.5">
          {TOP_MENUS.map((menu) => {
            const isActive = menu.items.some((item) => isNavItemActive(pathname, item));
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
                  if (event.key === "Escape") {
                    if (!isOpen) return;
                    event.preventDefault();
                    closeMenu();
                    event.currentTarget.querySelector<HTMLButtonElement>("[data-section-trigger]")?.focus();
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
                    return;
                  }
                  // Roving lives inside the disclosure panel (still no
                  // role=menu): arrows step through rows with wrap, Home/End
                  // jump to the ends.
                  const links = [
                    ...event.currentTarget.querySelectorAll<HTMLAnchorElement>(`#${panelId} a[href]`),
                  ];
                  if (!isOpen) {
                    // The panel is closed (hidden + inert, so its rows cannot
                    // take focus yet): ArrowDown opens it pinned; the
                    // pending-focus effect lands on the first row once the
                    // open state commits.
                    if (event.key !== "ArrowDown") return;
                    event.preventDefault();
                    pendingKeyboardOpen.current = menu.key;
                    openPinned(menu.key);
                    return;
                  }
                  event.preventDefault();
                  const currentIndex = links.findIndex((link) => link === document.activeElement);
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? links.length - 1
                        : currentIndex === -1
                          ? event.key === "ArrowDown"
                            ? 0
                            : links.length - 1
                          : event.key === "ArrowDown"
                            ? (currentIndex + 1) % links.length
                            : (currentIndex - 1 + links.length) % links.length;
                  links[nextIndex]?.focus();
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
                  onClick={() => activateMenu(menu.key)}
                  className={cn(
                    "pharos-focus-ring inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-sm font-medium whitespace-nowrap transition-colors min-[1440px]:px-3",
                    isActive
                      ? "bg-muted/60 text-foreground ring-1 ring-border/70 dark:bg-card dark:ring-1 dark:ring-border/80"
                      : isOpen
                        ? "bg-muted/40 text-foreground"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {menu.label}
                  <ChevronDown className="size-3 opacity-50" aria-hidden />
                </button>
                {/* Panels stay mounted so every destination is in the static
                    HTML (crawl links); closed panels are hidden + inert, so
                    they are neither visible nor focusable. */}
                <div id={panelId} hidden={!isOpen} inert={!isOpen} className="absolute right-0 top-full z-modal pt-2">
                    <div className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 w-[20rem] origin-top-right overflow-x-hidden overflow-y-auto rounded-md border p-1.5 shadow-md">
                      {(menu.sections ?? [{ key: menu.key, label: null, items: menu.items }]).map((section) =>
                        section.compact ? (
                          // The compact tier closes the panel: a muted strip
                          // under a hairline, bled to the panel edges.
                          <div
                            key={section.key}
                            className="-mx-1.5 -mb-1.5 mt-1.5 border-t border-border/60 bg-muted/30 px-1.5 pt-2.5 pb-1.5"
                          >
                            {section.label ? (
                              <p className="pharos-label mb-1 px-2 text-muted-foreground">{section.label}</p>
                            ) : null}
                            {/* Column-first in rows of four; nav-config orders the
                                tier so each column reads as one group. */}
                            <ul className="grid grid-flow-col grid-rows-4 gap-x-1">
                              {section.items.map((item) => (
                                <NavMenuItem
                                  key={item.href}
                                  item={item}
                                  group={menu.key}
                                  isActive={isNavItemActive(pathname, item)}
                                  variant="compact"
                                  onNavigate={closeMenu}
                                />
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <ul key={section.key}>
                            {section.items.map((item) => (
                              <NavMenuItem
                                key={item.href}
                                item={item}
                                group={menu.key}
                                isActive={isNavItemActive(pathname, item)}
                                variant="row"
                                onNavigate={closeMenu}
                              />
                            ))}
                          </ul>
                        ),
                      )}
                    </div>
                </div>
              </div>
            );
          })}
        </nav>
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />
        <RegimeBarToggle />
        {!isEditorialRoute ? (
          <button
            type="button"
            onClick={openKeyboardShortcuts}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="pharos-focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/20 font-mono text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground"
          >
            <span aria-hidden="true">?</span>
          </button>
        ) : null}
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
          // Icon-only below xl: at 1024px the six-item rail and menus fill the
          // masthead, so the text label and shortcut hint wait for xl (1280px).
          className="pharos-focus-ring inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/20 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground xl:w-40 xl:justify-start xl:px-2.5 min-[1440px]:w-[15rem] min-[1440px]:px-3 2xl:w-72"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="hidden xl:inline min-[1440px]:hidden">Search</span>
          <span className="hidden min-[1440px]:inline">Coin or page</span>
          <kbd className="ml-auto hidden shrink-0 rounded-sm border border-border/70 bg-background px-1.5 font-mono text-3xs whitespace-nowrap text-muted-foreground xl:inline">
            {searchShortcutLabel}
          </kbd>
        </button>

      </div>
    </header>
  );
}
