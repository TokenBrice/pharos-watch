"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PharosLogo } from "@/components/pharos-logo";
import { RegimeBarToggle } from "@/components/regime-bar";
import { ThemeControls } from "@/components/theme-controls";
import { Sheet, SheetTrigger, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  NAV_GROUPS,
  QUICK_NAV_ITEMS,
  isNavItemActive,
  stickyChromeTopOffsetClass,
} from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { ChevronLeft, ChevronRight, ExternalLink, Menu, Search, X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { openCommandPalette } from "@/lib/command-palette";
import { OPEN_NAV_DRAWER_EVENT } from "@/lib/nav-drawer";

function MobileNavLink({
  item,
  active,
  group,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  /** Analytics bucket for the tap: the category key. */
  group: string;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const className = `pharos-focus-ring flex items-center gap-3 rounded-lg border px-3 py-3 transition-[background-color,border-color,color,box-shadow] duration-[160ms] ease-[var(--motion-ease-standard)] ${
    active
      ? "border-border/70 bg-muted/60 font-medium text-foreground"
      : "border-transparent text-muted-foreground hover:border-border/55 hover:bg-muted/45 hover:text-foreground"
  }`;

  // External hrefs fall outside the nav_click contract's internal-path
  // namespace, so only in-app rows report.
  function handleClick() {
    if (!item.external) trackEvent("nav_click", { surface: "drawer", group, href: item.href });
    onNavigate();
  }

  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {/* Desktop menus carry these lines too; without them invented names
          (FreezeWatch, Compliance, DDR) are illegible in the drawer. */}
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm">
          {item.label}
          {item.external && <ExternalLink className="h-3 w-3 text-muted-foreground/70" aria-hidden="true" />}
        </span>
        {item.description ? (
          <span className="text-xs font-normal text-muted-foreground">{item.description}</span>
        ) : null}
      </div>
    </>
  );

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
        aria-label={`${item.label} (opens in new tab)`}
        className={className}
      >
        {body}
      </a>
    );
  }

  return (
    <Link
      prefetch={false}
      href={item.href}
      onClick={handleClick}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {body}
    </Link>
  );
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [activeCategoryKey, setActiveCategoryKey] = useState<string | null>(null);
  const categoryHeadingRef = useRef<HTMLHeadingElement>(null);
  const categoryButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusCategoryKeyRef = useRef<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  // One taxonomy at every width: the drawer's categories are the desktop
  // menus, and a columned menu (Resources) keeps its columns as subheads.
  const mobileCategories = NAV_GROUPS.map((group) => {
    const sections: Array<{ key: string; label: string | null; items: readonly NavItem[] }> = group.columns
      ? group.columns.map((column) => ({ key: `${group.key}:${column.key}`, label: column.label, items: column.items }))
      : [{ key: group.key, label: null, items: group.items }];
    return { key: group.key, label: group.label, sections, items: sections.flatMap((section) => section.items) };
  });
  const activeCategory = mobileCategories.find((category) => category.key === activeCategoryKey) ?? null;
  // The quick rail occupies the first animation slot.
  const mobileLeadItemCount = 1;
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setActiveCategoryKey(null);
      returnFocusCategoryKeyRef.current = null;
    }
  }

  function handleNavigate() {
    handleOpenChange(false);
  }

  function openCategory(categoryKey: string) {
    returnFocusCategoryKeyRef.current = null;
    setActiveCategoryKey(categoryKey);
  }

  function returnToRoot() {
    returnFocusCategoryKeyRef.current = activeCategoryKey;
    setActiveCategoryKey(null);
  }

  useEffect(() => {
    function handleOpenNavDrawer() {
      setActiveCategoryKey(null);
      returnFocusCategoryKeyRef.current = null;
      setOpen(true);
    }

    window.addEventListener(OPEN_NAV_DRAWER_EVENT, handleOpenNavDrawer);
    return () => window.removeEventListener(OPEN_NAV_DRAWER_EVENT, handleOpenNavDrawer);
  }, []);

  useEffect(() => {
    if (!open) return;

    if (activeCategoryKey) {
      navRef.current?.scrollTo?.({ top: 0 });
      categoryHeadingRef.current?.focus();
      return;
    }

    const categoryKey = returnFocusCategoryKeyRef.current;
    if (categoryKey) {
      categoryButtonRefs.current.get(categoryKey)?.focus();
      returnFocusCategoryKeyRef.current = null;
    }
  }, [activeCategoryKey, open]);

  // The header renders above the core rail in flow, so it pins directly under
  // the PSI strip on every route; z-chrome-header keeps the tape and rail
  // sliding beneath it while scrolling.
  return (
    <header
      className={`sticky z-chrome-header border-b border-border/80 bg-background/85 backdrop-blur-md lg:hidden ${topOffsetClass}`}
    >
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link
          prefetch={false}
          href="/"
          className="pharos-focus-ring flex min-h-11 min-w-0 items-center gap-2.5 rounded-md py-1 font-semibold"
        >
          <PharosLogo size={32} priority />
          <span className="pharos-display truncate text-[1.45rem] font-semibold leading-none tracking-tight text-foreground">
            Pharos
          </span>
        </Link>

        <div className="flex items-center gap-1">
          <RegimeBarToggle />
          {/* Labeled pill, not a bare icon: search is the fastest path to a
              coin profile, and an unlabeled magnifier hides that at 360px.
              shrink-0 keeps the pill intact while the logo text truncates. */}
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label="Search stablecoins and pages"
            className="pharos-focus-ring flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            Search
          </button>

          <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-11 w-11">
                <Menu className="h-4 w-4" />
                <span className="sr-only">Menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              showCloseButton={false}
              // Motion overrides retime the shadcn slide (500/300ms ease-in-out)
              // to the canon 220ms decelerating curve and drop it entirely for
              // prefers-reduced-motion — kept local so ui/sheet stays stock.
              className="w-full sm:max-w-full flex flex-col border-r border-border/70 bg-card p-0 ease-[var(--motion-ease-standard)] data-[state=open]:duration-[220ms] data-[state=closed]:duration-[220ms] motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 h-14 border-b border-border/70 shrink-0">
                <Link
                  prefetch={false}
                  href="/"
                  onClick={handleNavigate}
                  className="pharos-focus-ring flex items-center gap-3 rounded-md"
                >
                  <PharosLogo size={28} />
                  <SheetTitle className="pharos-display text-[1.45rem] leading-none tracking-tight">Pharos</SheetTitle>
                </Link>
                <SheetDescription className="sr-only">
                  Main navigation for Pharos dashboard routes, monitoring tools, references, and companion experiences.
                </SheetDescription>
                <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => handleOpenChange(false)}>
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close menu</span>
                </Button>
              </div>

              {/* Navigation */}
              <nav ref={navRef} className="flex-1 overflow-y-auto px-4 py-4" aria-label="Main navigation">
                {activeCategory ? (
                  <div
                    key={activeCategory.key}
                    className="animate-in fade-in slide-in-from-right-2 duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:animate-none"
                  >
                    <button
                      type="button"
                      onClick={returnToRoot}
                      className="pharos-focus-ring mb-4 flex min-h-11 w-full items-center gap-2 rounded-lg border-b border-border/70 px-3 text-sm font-medium text-muted-foreground transition-colors duration-[220ms] ease-[var(--motion-ease-standard)] hover:bg-muted/45 hover:text-foreground motion-reduce:transition-none"
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                      Back to menu
                    </button>
                    <h2
                      ref={categoryHeadingRef}
                      tabIndex={-1}
                      className="pharos-display mb-3 rounded-md text-xl font-semibold tracking-tight text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {activeCategory.label}
                    </h2>
                    {activeCategory.sections.map((section) => (
                      <div key={section.key} className={section.label ? "mt-4 first-of-type:mt-0" : undefined}>
                        {section.label ? (
                          <h3 className="mb-1 px-3 text-xs font-medium text-muted-foreground">{section.label}</h3>
                        ) : null}
                        {section.items.map((item) => (
                          <MobileNavLink
                            key={item.href}
                            item={item}
                            active={isNavItemActive(pathname, item)}
                            group={section.key}
                            onNavigate={handleNavigate}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    key="root"
                    className="animate-in fade-in slide-in-from-left-2 duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:animate-none"
                  >
                    {/* Quick rail: the highest-traffic routes, always visible. */}
                    <div
                      className="grid grid-cols-2 gap-2 pl-[14px] animate-in fade-in slide-in-from-left-2 ease-[var(--motion-ease-standard)] [animation-fill-mode:backwards] motion-reduce:animate-none"
                      style={{ animationDelay: "0ms", animationDuration: "220ms" }}
                    >
                      {QUICK_NAV_ITEMS.map((item) => {
                        const Icon = item.icon;
                        const active = isNavItemActive(pathname, item);
                        return (
                          <Link
                            key={item.href}
                            prefetch={false}
                            href={item.href}
                            onClick={() => {
                              trackEvent("nav_click", { surface: "drawer", group: "rail", href: item.href });
                              handleNavigate();
                            }}
                            aria-current={active ? "page" : undefined}
                            className={`pharos-focus-ring flex min-h-16 flex-col justify-between rounded-lg border px-3 py-2.5 transition-colors ${
                              active ? "border-border/70 bg-muted/60" : "border-border/45 bg-muted/20 hover:bg-muted/40"
                            }`}
                          >
                            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                            <span className="text-sm font-semibold leading-tight text-foreground">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>

                    {/* Category drill-down rows. */}
                    {mobileCategories.map((category, categoryIndex) => {
                      const categoryIsActive = category.items.some((item) => isNavItemActive(pathname, item));
                      return (
                        <div
                          key={category.key}
                          className={`mt-2 animate-in fade-in slide-in-from-left-2 ease-[var(--motion-ease-standard)] [animation-fill-mode:backwards] motion-reduce:animate-none ${
                            categoryIsActive ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                          }`}
                          style={{
                            animationDelay: `${(mobileLeadItemCount + categoryIndex) * 50}ms`,
                            animationDuration: "220ms",
                          }}
                        >
                          <button
                            ref={(element) => {
                              if (element) categoryButtonRefs.current.set(category.key, element);
                              else categoryButtonRefs.current.delete(category.key);
                            }}
                            type="button"
                            onClick={() => openCategory(category.key)}
                            aria-label={`${category.label}, ${category.items.length} pages`}
                            className="pharos-focus-ring flex min-h-11 w-full items-center justify-between rounded-lg border border-transparent px-3 text-sm font-medium text-foreground transition-[background-color,border-color,color,box-shadow] duration-[220ms] ease-[var(--motion-ease-standard)] hover:border-border/55 hover:bg-muted/45 motion-reduce:transition-none"
                          >
                            <span className="flex items-center gap-2">
                              {category.label}
                              <span className="rounded-full bg-muted px-1.5 font-mono text-3xs font-semibold tabular-nums text-muted-foreground/70">
                                {category.items.length}
                              </span>
                            </span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}

                  </div>
                )}
              </nav>

              {/* Footer */}
              <div className="border-t border-border/70 bg-muted/20 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] flex items-center justify-between shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 min-h-11"
                  onClick={() => {
                    handleOpenChange(false);
                    openCommandPalette();
                  }}
                >
                  <Search className="h-4 w-4" />
                  Search
                </Button>
                <ThemeControls density="mobile" />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
