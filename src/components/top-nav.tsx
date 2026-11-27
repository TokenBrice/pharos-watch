"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Search, SunMoon } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import { useHydrated } from "@/hooks/use-hydrated";
import { RegimeBarToggle } from "@/components/psi-beacon/regime-bar";
import { ThemeControls } from "@/components/theme-controls";
import { OPEN_COMMAND_PALETTE_EVENT, openCommandPalette } from "@/lib/command-palette";
import {
  dismissChromeOverlays,
  openKeyboardShortcuts,
  subscribeChromeDismiss,
} from "@/lib/chrome-popover";
import { trackEvent } from "@/lib/analytics";
import {
  DESKTOP_QUICK_NAV_ITEMS,
  NAV_GROUPS,
  isNavItemActive,
  stickyChromeTopOffsetClass,
  type NavGroup,
  type NavItem,
} from "@/lib/nav-config";
import { cn } from "@/lib/utils";

const TOP_MENUS: readonly NavGroup[] = NAV_GROUPS;
const APPEARANCE_PANEL_ID = "top-nav-appearance-panel";
const HOVER_OPEN_DELAY_MS = 350;
const HOVER_SWITCH_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 450;

/**
 * Single described menu row. Every destination carries an authored one-line
 * description beside its icon tile so keyboard, touch, and screen-reader users
 * get the same guidance as pointer users.
 */
function NavMenuItem({
  item,
  group,
  isActive,
  tinted = false,
  onNavigate,
}: {
  item: NavItem;
  group: string;
  isActive: boolean;
  tinted?: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const descriptionId = useId();
  const hasDescription = Boolean(item.description);

  return (
    <li>
      <Link
        href={item.href}
        prefetch={false}
        aria-label={item.external ? `${item.label} (opens in new tab)` : undefined}
        aria-current={isActive ? "page" : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        onClick={() => {
          // External hrefs fall outside the nav_click contract's internal-path
          // namespace (src/lib/analytics.ts), so only in-app rows report.
          if (!item.external) {
            trackEvent("nav_click", { surface: "menu", group, href: item.href });
          }
          onNavigate();
        }}
        className={cn(
          "pharos-focus-ring group/nav-item relative flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm select-none transition-colors focus:text-accent-foreground",
          tinted
            ? "hover:bg-card/80 focus:bg-card/80 dark:hover:bg-card/70 dark:focus:bg-card/70"
            : "hover:bg-muted/60 focus:bg-muted/60",
          isActive &&
            (tinted
              ? "bg-card ring-1 ring-border/70 dark:bg-card dark:ring-border/80"
              : "bg-muted/60 ring-1 ring-border/60 dark:bg-card dark:ring-border/80"),
        )}
        {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-md border transition-colors group-hover/nav-item:border-border group-hover/nav-item:text-foreground",
            isActive
              ? "border-border bg-background text-foreground"
              : "border-border/50 bg-muted/40 text-muted-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-sm font-medium text-foreground">
            {item.label}
            {item.external ? (
              <>
                <ArrowUpRight className="size-3 text-muted-foreground/70" aria-hidden="true" />
                <span className="sr-only"> (opens in new tab)</span>
              </>
            ) : null}
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
 * Desktop masthead nav (≥lg). A five-item quick rail anchors left of the fold
 * and five section menus (Markets, Risk, Tools, Learn, Pharos) anchor right
 * beside the utility controls (PSI regime toggle, Appearance + shortcuts
 * disclosure, and Search) inside one balanced masthead. Mobile keeps <Header />.
 */
export function TopNav() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);
  const hydrated = useHydrated();
  const isApplePlatform =
    hydrated && typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const searchShortcutLabel = isApplePlatform ? "⌘K" : "Ctrl K";
  // Recent/escalating open-incident badge on the Depeg item (Decision D):
  // visually shown only when split counts are present and recent > 0 so the
  // pill never flaps between recent and total across degraded/legacy reads.
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
  const depegTitle = !hasIncidentSplit
    ? null
    : recentDepegCount! > 0
      ? longRunningDepegCount! > 0
        ? `${recentDepegCount} recent · ${longRunningDepegCount} long-running (>30d) active depegs`
        : `${recentDepegCount} recent active ${recentDepegCount === 1 ? "depeg" : "depegs"}`
      : longRunningDepegCount! > 0
        ? `0 recent · ${longRunningDepegCount} long-running (>30d) active ${longRunningDepegCount === 1 ? "depeg" : "depegs"}`
        : null;

  // Desktop hover-to-open for the section disclosures is gated per-event on
  // `pointerType === "mouse"`, so hybrid touch laptops keep tap-to-open without
  // a mount-time matchMedia probe. A transient hover flag keeps hover panels
  // dismissible while protecting click- or keyboard-pinned menus.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpenMenu(null);
    setAppearanceOpen(false);
  }

  const primaryNavRef = useRef<HTMLElement>(null);
  const appearanceRegionRef = useRef<HTMLDivElement>(null);
  const appearanceTriggerRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openMenuRef = useRef<string | null>(null);
  const appearanceOpenRef = useRef(false);
  const hoverOpenRef = useRef(false);
  const wasHoverOpenOnPointerDownRef = useRef<string | null>(null);
  const pointerInsideMenuRef = useRef<string | null>(null);
  // Set when ArrowDown opens a closed trigger: the panel's rows are inert
  // until the open state commits, so the first-row focus lands in an effect.
  const pendingKeyboardOpen = useRef<string | null>(null);

  const cancelOpen = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const commitOpenMenu = useCallback((next: string | null) => {
    openMenuRef.current = next;
    setOpenMenu(next);
  }, []);

  const commitAppearanceOpen = useCallback((next: boolean) => {
    appearanceOpenRef.current = next;
    setAppearanceOpen(next);
  }, []);

  const closeMenu = useCallback(() => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    wasHoverOpenOnPointerDownRef.current = null;
    commitOpenMenu(null);
  }, [cancelClose, cancelOpen, commitOpenMenu]);

  useEffect(() => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    wasHoverOpenOnPointerDownRef.current = null;
    openMenuRef.current = null;
    appearanceOpenRef.current = false;
  }, [pathname, cancelClose, cancelOpen]);

  useEffect(() => () => {
    cancelOpen();
    cancelClose();
    if (pointerClearTimer.current) {
      clearTimeout(pointerClearTimer.current);
      pointerClearTimer.current = null;
    }
  }, [cancelClose, cancelOpen]);

  useEffect(() => {
    const stopTopNav = subscribeChromeDismiss("top-nav", closeMenu);
    const stopAppearance = subscribeChromeDismiss("appearance", () => commitAppearanceOpen(false));
    const onOpenPalette = () => {
      closeMenu();
      commitAppearanceOpen(false);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenPalette);
    return () => {
      stopTopNav();
      stopAppearance();
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenPalette);
    };
  }, [closeMenu, commitAppearanceOpen]);

  const sectionMenuOpen = TOP_MENUS.some((menu) => menu.key === openMenu);
  const anyChromePanelOpen = sectionMenuOpen || appearanceOpen;
  useEffect(() => {
    if (!anyChromePanelOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (openMenuRef.current) {
          const activeRegion = primaryNavRef.current?.querySelector<HTMLElement>(
            `[data-section-menu="${openMenuRef.current}"]`,
          );
          if (activeRegion?.contains(target)) return;
        }
        if (appearanceRegionRef.current?.contains(target)) return;
      }
      if (openMenuRef.current) closeMenu();
      if (appearanceOpenRef.current) commitAppearanceOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [anyChromePanelOpen, closeMenu, commitAppearanceOpen]);

  // ArrowDown can open a panel whose rows are still inert; land focus on the
  // first row once that menu's open state has actually committed.
  useEffect(() => {
    const key = pendingKeyboardOpen.current;
    if (!key) return;
    pendingKeyboardOpen.current = null;
    if (openMenu !== key) return;
    primaryNavRef.current?.querySelector<HTMLElement>(`[data-section-menu="${key}"] a[href]`)?.focus();
  }, [openMenu]);

  // A hover-opened panel (or open Appearance disclosure) must be dismissible
  // via Escape even when focus sits elsewhere on the page (WCAG 1.4.13).
  useEffect(() => {
    if (!anyChromePanelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openMenuRef.current) {
        const region = primaryNavRef.current?.querySelector<HTMLElement>(
          `[data-section-menu="${openMenuRef.current}"]`,
        );
        if (region?.contains(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        return;
      }
      if (appearanceOpenRef.current) {
        if (appearanceRegionRef.current?.contains(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        commitAppearanceOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anyChromePanelOpen, closeMenu, commitAppearanceOpen]);

  const openOnHover = (key: string) => {
    // Never hijack a click- or keyboard-pinned section menu, a keyboard-focused
    // hover panel, or an open Appearance disclosure.
    if (appearanceOpenRef.current) return;
    if (openMenuRef.current !== null) {
      if (!hoverOpenRef.current) return;
      const activeRegion = primaryNavRef.current?.querySelector<HTMLElement>(
        `[data-section-menu="${openMenuRef.current}"]`,
      );
      if (activeRegion?.contains(document.activeElement)) return;
    }

    cancelClose();
    cancelOpen();
    if (openMenuRef.current === key) return;

    // Opening from closed waits longer than switching: a stray sweep across
    // the bar should not flash panels (NN/g hover-intent guidance).
    openTimer.current = setTimeout(
      () => {
        openTimer.current = null;
        if (appearanceOpenRef.current) return;
        if (openMenuRef.current !== null) {
          if (!hoverOpenRef.current) return;
          const activeRegion = primaryNavRef.current?.querySelector<HTMLElement>(
            `[data-section-menu="${openMenuRef.current}"]`,
          );
          if (activeRegion?.contains(document.activeElement)) return;
        }
        hoverOpenRef.current = true;
        dismissChromeOverlays("top-nav");
        commitOpenMenu(key);
      },
      openMenuRef.current === null ? HOVER_OPEN_DELAY_MS : HOVER_SWITCH_DELAY_MS,
    );
  };

  const closeOnHover = () => {
    cancelOpen();
    cancelClose();
    const activeKey = openMenuRef.current;
    if (!hoverOpenRef.current || activeKey === null) return;

    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      const activeRegion = primaryNavRef.current?.querySelector<HTMLElement>(
        `[data-section-menu="${activeKey}"]`,
      );
      if (activeRegion?.contains(document.activeElement)) {
        hoverOpenRef.current = false;
        return;
      }
      hoverOpenRef.current = false;
      commitOpenMenu(null);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const activateMenu = (key: string) => {
    cancelOpen();
    cancelClose();
    const wasHoverOpen =
      wasHoverOpenOnPointerDownRef.current === key ||
      (hoverOpenRef.current && openMenuRef.current === key);
    wasHoverOpenOnPointerDownRef.current = null;
    hoverOpenRef.current = false;
    if (wasHoverOpen && openMenuRef.current === key) {
      // Pin the hover-opened panel open instead of toggling it closed.
      return;
    }
    const next = openMenuRef.current === key ? null : key;
    if (next !== null) dismissChromeOverlays("top-nav");
    commitOpenMenu(next);
  };

  // Keyboard opens are pinned like clicks and never toggle: ArrowDown on a
  // closed trigger means "open", and the same key then roves the rows.
  const openPinned = (key: string) => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    wasHoverOpenOnPointerDownRef.current = null;
    dismissChromeOverlays("top-nav");
    commitOpenMenu(key);
  };

  const handleAppearanceOpenChange = (next: boolean) => {
    cancelOpen();
    cancelClose();
    hoverOpenRef.current = false;
    wasHoverOpenOnPointerDownRef.current = null;
    if (next) {
      if (openMenuRef.current) commitOpenMenu(null);
      dismissChromeOverlays("appearance");
    }
    commitAppearanceOpen(next);
  };

  // Elevate header from z-chrome-header to z-modal while a nav panel or
  // Appearance disclosure is open so no sticky sibling or regime band can overlap it.
  return (
    <header
      className={cn(
        "sticky hidden h-14 w-full items-center gap-1.5 border-b border-border/70 bg-background/85 px-3 backdrop-blur-md lg:flex xl:gap-2 xl:px-4 2xl:px-6",
        anyChromePanelOpen ? "z-modal" : "z-chrome-header",
        topOffsetClass,
      )}
    >
      <Link
        href="/"
        prefetch={false}
        aria-label="Pharos home"
        aria-current={isHome ? "page" : undefined}
        className="group/brand pharos-focus-ring flex shrink-0 cursor-pointer items-center gap-2 rounded-lg pr-0.5 transition-colors xl:pr-1 2xl:gap-2.5 2xl:pr-2"
      >
        <PharosLogo
          size={28}
          className={cn(
            "rounded-full shadow-sm transition-shadow",
            isHome && "ring-1 ring-border/80 ring-offset-1 ring-offset-background",
          )}
          priority
        />
        {/* Wordmark waits for xl: at lg the mark alone carries the brand so the
            five-item rail, five section menus, PSI toggle and search fit 1024px. */}
        <span
          className={cn(
            "pharos-display hidden text-base font-bold tracking-tight transition-colors xl:inline",
            isHome ? "text-foreground" : "text-foreground/90 group-hover/brand:text-foreground",
          )}
        >
          Pharos
        </span>
      </Link>

      <nav
        ref={primaryNavRef}
        aria-label="Primary"
        className="flex min-w-0 flex-1 items-center gap-1.5 xl:gap-2"
      >
        <div className="flex shrink-0 items-center gap-0 rounded-lg border border-border/50 bg-muted/35 p-0.5 2xl:gap-0.5">
          {DESKTOP_QUICK_NAV_ITEMS.map((item) => {
            const isActive = isNavItemActive(pathname, item);
            const Icon = item.icon;
            const isDepeg = item.href === "/depeg/";
            const badge = isDepeg && recentDepegCount && recentDepegCount > 0 ? recentDepegCount : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
                title={isDepeg && depegTitle ? depegTitle : item.description}
                onClick={() => trackEvent("nav_click", { surface: "rail", group: "rail", href: item.href })}
                className={cn(
                  "group pharos-focus-ring inline-flex h-8 cursor-pointer items-center gap-1 rounded-md px-1.5 text-sm font-semibold whitespace-nowrap transition-colors min-[90rem]:px-2 2xl:gap-1.5 2xl:px-2.5",
                  isActive
                    ? "bg-card text-foreground ring-1 ring-border/70 dark:bg-card dark:ring-border/80"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {/* The icon is the affordance that separates a direct link from
                    a menu trigger; triggers carry a chevron and no glyph. */}
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-opacity",
                    isActive ? "opacity-100" : "opacity-70 group-hover:opacity-100",
                  )}
                  aria-hidden="true"
                />
                {/* Three label tiers step up with masthead slack: compact below
                    1440px (90rem — keeps Freeze compact through 1280px so
                    wordmark + 10rem Search + Depeg badge fit comfortably),
                    short from 1440px to 1679px, canonical from 1680px (105rem). */}
                <span className="min-[90rem]:hidden">{item.compactLabel ?? item.shortLabel ?? item.label}</span>
                <span className="hidden min-[90rem]:inline min-[105rem]:hidden">{item.shortLabel ?? item.label}</span>
                <span className="hidden min-[105rem]:inline">{item.label}</span>
                {/* A 16px glyph is too small to carry a count; it reads as a neutral pill after the label. */}
                {badge ? (
                  <span
                    aria-hidden="true"
                    className="rounded-full bg-muted px-1.5 py-px font-mono text-2xs font-semibold leading-none tabular-nums text-muted-foreground"
                  >
                    {badge}
                  </span>
                ) : null}
                {isDepeg && depegSrText ? (
                  <span className="sr-only">{depegSrText}</span>
                ) : null}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {TOP_MENUS.map((menu, menuIndex) => {
            const isActive = menu.items.some((item) => isNavItemActive(pathname, item));
            const isOpen = openMenu === menu.key;
            const panelId = `top-nav-${menu.key}-panel`;
            const sections = menu.sections ?? [{ key: menu.key, label: null, items: menu.items }];
            const quickBarLabelId = `${panelId}-quick-bar-label`;

            return (
              <div
                key={menu.key}
                data-section-menu={menu.key}
                className="relative"
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") openOnHover(menu.key);
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === "mouse") closeOnHover();
                }}
                onPointerDown={() => {
                  pointerInsideMenuRef.current = menu.key;
                  if (pointerClearTimer.current) clearTimeout(pointerClearTimer.current);
                  pointerClearTimer.current = setTimeout(() => {
                    pointerClearTimer.current = null;
                    if (pointerInsideMenuRef.current === menu.key) {
                      pointerInsideMenuRef.current = null;
                    }
                  }, 0);
                }}
                onFocus={() => {
                  if (openMenuRef.current === menu.key) {
                    hoverOpenRef.current = false;
                  }
                }}
                onBlur={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
                    return;
                  }
                  if (pointerInsideMenuRef.current === menu.key) return;
                  if (openMenuRef.current !== menu.key) return;
                  closeMenu();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    if (!isOpen) return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeMenu();
                    event.currentTarget.querySelector<HTMLButtonElement>("[data-section-trigger]")?.focus();
                    return;
                  }
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const nextIndex =
                      event.key === "ArrowRight"
                        ? (menuIndex + 1) % TOP_MENUS.length
                        : (menuIndex - 1 + TOP_MENUS.length) % TOP_MENUS.length;
                    const nextMenu = TOP_MENUS[nextIndex]!;
                    if (isOpen) openPinned(nextMenu.key);
                    primaryNavRef.current
                      ?.querySelector<HTMLButtonElement>(
                        `[data-section-menu="${nextMenu.key}"] [data-section-trigger]`,
                      )
                      ?.focus();
                    return;
                  }
                  if (
                    event.key !== "ArrowDown" &&
                    event.key !== "ArrowUp" &&
                    event.key !== "Home" &&
                    event.key !== "End"
                  ) {
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
                    cancelClose();
                    wasHoverOpenOnPointerDownRef.current =
                      hoverOpenRef.current && openMenuRef.current === menu.key ? menu.key : null;
                    hoverOpenRef.current = false;
                  }}
                  onClick={() => activateMenu(menu.key)}
                  className={cn(
                    "pharos-focus-ring inline-flex h-8 cursor-pointer items-center gap-1 rounded-md px-1.5 text-sm font-medium whitespace-nowrap transition-colors min-[90rem]:px-2 2xl:px-2.5",
                    isActive
                      ? "bg-muted/60 text-foreground ring-1 ring-border/70 dark:bg-card dark:ring-border/80"
                      : isOpen
                        ? "bg-muted/40 text-foreground"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {menu.label}
                  <ChevronDown
                    className={cn(
                      "size-3 opacity-50 transition-transform duration-150",
                      isOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
                {/* Panels stay mounted so every destination is in the static
                    HTML (crawl links); closed panels are hidden + inert, so
                    they are neither visible nor focusable. */}
                <div
                  id={panelId}
                  hidden={!isOpen}
                  inert={!isOpen}
                  className="absolute right-0 top-full z-modal pt-2"
                >
                  <div
                    tabIndex={-1}
                    className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 w-[20rem] max-h-[calc(100dvh-5rem)] origin-top-right overflow-x-hidden overflow-y-auto rounded-xl border p-1.5 shadow-[shadow:var(--elevation-raised)] outline-none"
                  >
                    {sections.map((section) => {
                      const sectionLabelId = section.label ? `${panelId}-${section.key}-label` : undefined;
                      if (section.companion) {
                        return (
                          <div
                            key={section.key}
                            className="-mx-1.5 -mb-1.5 mt-1.5 border-t border-border/60 bg-muted/35 p-1.5"
                          >
                            {section.label ? (
                              <p id={sectionLabelId} className="pharos-label mb-1 px-2 text-muted-foreground">
                                {section.label}
                              </p>
                            ) : null}
                            <ul aria-labelledby={sectionLabelId}>
                              {section.items.map((item) => (
                                <NavMenuItem
                                  key={item.href}
                                  item={item}
                                  group={menu.key}
                                  isActive={isNavItemActive(pathname, item)}
                                  tinted
                                  onNavigate={closeMenu}
                                />
                              ))}
                            </ul>
                          </div>
                        );
                      }

                      if (section.label) {
                        return (
                          <div key={section.key} className="mt-1.5 border-t border-border/60 pt-2">
                            <p id={sectionLabelId} className="pharos-label mb-1 px-2 text-muted-foreground">
                              {section.label}
                            </p>
                            <ul aria-labelledby={sectionLabelId}>
                              {section.items.map((item) => (
                                <NavMenuItem
                                  key={item.href}
                                  item={item}
                                  group={menu.key}
                                  isActive={isNavItemActive(pathname, item)}
                                  onNavigate={closeMenu}
                                />
                              ))}
                            </ul>
                          </div>
                        );
                      }

                      return (
                        <ul key={section.key}>
                          {section.items.map((item) => (
                            <NavMenuItem
                              key={item.href}
                              item={item}
                              group={menu.key}
                              isActive={isNavItemActive(pathname, item)}
                              onNavigate={closeMenu}
                            />
                          ))}
                        </ul>
                      );
                    })}

                    {menu.quickBarLinks?.length ? (
                      <div className="-mx-1.5 -mb-1.5 mt-1.5 border-t border-border/60 bg-muted/25 px-3 py-2">
                        <p id={quickBarLabelId} className="pharos-label text-muted-foreground">
                          On the quick bar
                        </p>
                        <ul
                          aria-labelledby={quickBarLabelId}
                          className="mt-1 flex flex-wrap gap-x-3 gap-y-1"
                        >
                          {menu.quickBarLinks.map((item) => {
                            const isQuickLinkActive = isNavItemActive(pathname, item);
                            return (
                              <li key={item.href}>
                                <Link
                                  href={item.href}
                                  prefetch={false}
                                  aria-current={isQuickLinkActive ? "page" : undefined}
                                  onClick={() => {
                                    if (!item.external) {
                                      trackEvent("nav_click", {
                                        surface: "menu",
                                        group: menu.key,
                                        href: item.href,
                                      });
                                    }
                                    closeMenu();
                                  }}
                                  className={cn(
                                    "pharos-focus-ring inline-flex cursor-pointer items-center rounded-sm text-xs transition-colors",
                                    isQuickLinkActive
                                      ? "bg-card px-1.5 py-0.5 font-medium text-foreground ring-1 ring-border/70 dark:bg-card dark:ring-border/80"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  {item.shortLabel ?? item.label}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </nav>

      {/* Right utility cluster: divider -> PSI regime toggle -> Appearance + shortcuts disclosure -> Search. */}
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />
      <div className="flex shrink-0 items-center gap-1 xl:gap-1.5 2xl:gap-2">
        <RegimeBarToggle className="h-8" />

        <div
          ref={appearanceRegionRef}
          className="relative"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !appearanceOpen) return;
            event.preventDefault();
            event.stopPropagation();
            commitAppearanceOpen(false);
            appearanceTriggerRef.current?.focus();
          }}
        >
          <button
            ref={appearanceTriggerRef}
            type="button"
            aria-label="Appearance"
            aria-expanded={appearanceOpen}
            aria-controls={APPEARANCE_PANEL_ID}
            onClick={() => handleAppearanceOpenChange(!appearanceOpen)}
            className={cn(
              "pharos-focus-ring inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
              appearanceOpen
                ? "bg-muted/50 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <SunMoon className="size-4" aria-hidden="true" />
          </button>
          {appearanceOpen ? (
            <div
              id={APPEARANCE_PANEL_ID}
              data-top-nav-appearance
              className="absolute right-0 top-full z-modal pt-2"
            >
              <div className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 w-auto origin-top-right rounded-xl border p-1.5 shadow-[shadow:var(--elevation-raised)]">
                <ThemeControls density="desktop" />
                <div className="mt-1.5 border-t border-border/60 pt-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      commitAppearanceOpen(false);
                      openKeyboardShortcuts();
                    }}
                    className="pharos-focus-ring flex h-8 w-full cursor-pointer items-center justify-between gap-4 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  >
                    <span>Keyboard shortcuts</span>
                    <kbd className="rounded-sm border border-border/70 bg-muted/50 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                      ?
                    </kbd>
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => {
            dismissChromeOverlays("command-palette");
            openCommandPalette();
          }}
          aria-label="Search coin or page"
          // Icon-only below xl: xl (1280-1439px) preserves the CSS build canary
          // `xl:w-[10rem]` with "Search"; 90rem (1440px+) steps up to "Coin or
          // page". Both visible labels are contained in `aria-label` (WCAG 2.5.3).
          className="pharos-focus-ring inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border/70 bg-muted/20 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground xl:w-[10rem] xl:justify-start xl:px-2.5 min-[90rem]:w-48 2xl:w-52 2xl:gap-2 2xl:px-3 min-[112.5rem]:w-60"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden whitespace-nowrap xl:inline min-[90rem]:hidden">Search</span>
          <span className="hidden whitespace-nowrap min-[90rem]:inline">Coin or page</span>
          <kbd className="ml-auto hidden shrink-0 rounded-sm border border-border/70 bg-background px-1.5 font-mono text-3xs whitespace-nowrap text-muted-foreground xl:inline">
            {searchShortcutLabel}
          </kbd>
        </button>
      </div>
    </header>
  );
}
