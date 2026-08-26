"use client";

import type { MutableRefObject, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { revealAnchorId } from "@/lib/anchor-reveal";

interface LongformSection {
  id: string;
  label: string;
  icon?: LucideIcon;
}

interface LongformScrollspyNavProps {
  sections: readonly LongformSection[];
  railLabel?: string;
  navAriaLabel: string;
  rightSlot?: ReactNode;
  className?: string;
  /** Show a subtle gradient fade below the nav hinting at content below */
  showDepthHint?: boolean;
  /** Called whenever the currently-in-view section changes. */
  onActiveChange?: (id: string) => void;
  /**
   * Complete viewport offset, in pixels, for shells with sticky chrome above
   * this navigation. The same value drives sticky positioning, hash
   * alignment, and active-section detection.
   */
  stickyOffsetPx?: number;
  /**
   * `banner` (default) renders a horizontal sticky bar.
   * `rail` renders a thin vertical column intended for a sticky right-rail TOC.
   */
  variant?: "banner" | "rail";
  /**
   * `watch-rail` (banner only) intensifies the lit pill and adds a
   * reading-progress beam that fills along the bottom edge as the reader
   * descends the sections. Opt-in for legacy dossier surfaces; other banner
   * surfaces keep the calmer default recipe.
   * `pill-tabs` (banner only) renders the Figma coin-template tab bar: a
   * rounded-full group on the neutral control fill, elevated-neutral active
   * pill (no frost), flanked by decorative hairlines on desktop.
   */
  emphasis?: "watch-rail" | "pill-tabs";
}

const STICKY_SUMMARY_VAR = "--pharos-sticky-summary-h";

function readStickySummaryHeight(): number {
  if (typeof document === "undefined") return 0;
  const raw = document.documentElement.style.getPropertyValue(STICKY_SUMMARY_VAR);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function getRailOffset(railNode: HTMLDivElement | null, stickyOffsetPx?: number) {
  const railRect = railNode?.getBoundingClientRect();
  if (!railRect) return 16;
  const stickyTop = stickyOffsetPx ?? Math.max(railRect.top, 0);
  return Math.ceil(railRect.height + stickyTop + 16);
}

function getScrollOffset(railNode: HTMLDivElement | null, stickyOffsetPx?: number) {
  return getRailOffset(railNode, stickyOffsetPx) + readStickySummaryHeight();
}

function getHashSectionId() {
  return decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

function scrollToSection(sectionId: string, railNode: HTMLDivElement | null, stickyOffsetPx?: number) {
  const sectionNode = revealAnchorId(sectionId);
  if (!sectionNode) return;

  const nextTop = window.scrollY + sectionNode.getBoundingClientRect().top - getScrollOffset(railNode, stickyOffsetPx);
  window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
}

function clearPendingScrollSync(pendingScrollSyncRef: MutableRefObject<number[]>) {
  for (const timer of pendingScrollSyncRef.current) {
    window.clearTimeout(timer);
  }
  pendingScrollSyncRef.current = [];
}

function scheduleSectionAlignment(
  sectionId: string,
  railNode: HTMLDivElement | null,
  pendingScrollSyncRef: MutableRefObject<number[]>,
  updateHash: boolean,
  stickyOffsetPx?: number,
) {
  clearPendingScrollSync(pendingScrollSyncRef);
  if (updateHash) {
    window.history.pushState(null, "", `#${sectionId}`);
  }
  scrollToSection(sectionId, railNode, stickyOffsetPx);

  for (const delay of [160, 480, 960]) {
    const timer = window.setTimeout(() => {
      if (getHashSectionId() === sectionId) {
        scrollToSection(sectionId, railNode, stickyOffsetPx);
      }
    }, delay);
    pendingScrollSyncRef.current.push(timer);
  }
}

function centerActivePill(scroller: HTMLElement | null, anchor: HTMLAnchorElement | null) {
  if (!scroller || !anchor) return;

  const scrollerRect = scroller.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const targetLeft =
    scroller.scrollLeft + anchorRect.left - scrollerRect.left - (scroller.clientWidth - anchorRect.width) / 2;
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);

  scroller.scrollTo({
    left: Math.min(maxLeft, Math.max(0, targetLeft)),
    behavior: "auto",
  });
}

function isDocumentBottom() {
  const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  return scrollHeight > window.innerHeight && window.scrollY + window.innerHeight >= scrollHeight - 1;
}

export function LongformScrollspyNav({
  sections,
  railLabel = "Jump to",
  navAriaLabel,
  rightSlot,
  className,
  showDepthHint,
  onActiveChange,
  stickyOffsetPx,
  variant = "banner",
  emphasis,
}: LongformScrollspyNavProps) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const railRef = useRef<HTMLDivElement | null>(null);
  const bannerScrollerRef = useRef<HTMLElement | null>(null);
  const activeAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const pendingScrollSyncRef = useRef<number[]>([]);
  const initialHashHandledRef = useRef(false);
  const activePillSyncedRef = useRef(false);
  const effectiveActiveId = sections.some((section) => section.id === activeId) ? activeId : (sections[0]?.id ?? "");
  const sectionSignature = sections.map((section) => section.id).join("|");

  useEffect(() => {
    onActiveChange?.(effectiveActiveId);
  }, [effectiveActiveId, onActiveChange]);

  // Keep the lit pill visible inside the horizontally-scrolling banner row
  // (it can sit off the right edge on narrow viewports). Skip the first run so
  // hydration doesn't hijack the page's initial scroll position.
  useEffect(() => {
    if (variant !== "banner") return;
    if (!activePillSyncedRef.current) {
      activePillSyncedRef.current = true;
      return;
    }
    centerActivePill(bannerScrollerRef.current, activeAnchorRef.current);
  }, [effectiveActiveId, variant]);

  useEffect(() => {
    const railNode = railRef.current;
    const sectionIds = sectionSignature.length > 0 ? sectionSignature.split("|") : [];
    const sectionNodes = sectionIds
      .map((sectionId) => document.getElementById(sectionId))
      .filter((node): node is HTMLElement => node !== null);

    if (!railNode || sectionNodes.length === 0) return;

    const applyScrollMargins = () => {
      // When two scrollspy navs are mounted in different responsive contexts
      // (banner on <lg, rail on lg+), the hidden instance has display:none and
      // a zero-size bounding box. Skip writing scroll margins from the hidden
      // instance so the visible one wins.
      const railRect = railNode.getBoundingClientRect();
      if (railRect.width === 0 && railRect.height === 0) return;

      const railOffset = getRailOffset(railNode, stickyOffsetPx);
      // `calc(...)` lets the mobile sticky summary's CSS var feed back into
      // scroll-margin reactively without a separate observer wiring.
      const scrollMarginTop = `calc(${railOffset}px + var(${STICKY_SUMMARY_VAR}, 0px))`;
      for (const node of sectionNodes) {
        node.style.scrollMarginTop = scrollMarginTop;
      }
    };

    // Active-section detection by scroll position rather than an
    // IntersectionObserver band. The active section is the last one whose
    // heading has scrolled up to (or past) the line just below the sticky
    // nav. Unlike a narrow observer band — which goes empty between the thin
    // heading strips and freezes the highlight on a stale section — this
    // always resolves to the section currently under the reader.
    let scrollFrame = 0;
    const computeActiveSection = () => {
      const railRect = railNode.getBoundingClientRect();
      if (railRect.width === 0 && railRect.height === 0) return; // hidden instance
      let nextActive = sectionNodes[0];
      if (window.scrollY <= 0) {
        nextActive = sectionNodes[0];
      } else if (isDocumentBottom()) {
        nextActive = sectionNodes[sectionNodes.length - 1];
      } else {
        const activationLine = getScrollOffset(railNode, stickyOffsetPx) + 8;
        for (const node of sectionNodes) {
          if (node.getBoundingClientRect().top <= activationLine) {
            nextActive = node;
          }
        }
      }
      if (nextActive) setActiveId(nextActive.id);

      // Reading-progress beam (watch-rail only): fraction of the dossier
      // scrolled, from the first heading reaching the activation line (0) to
      // the last section's bottom reaching the viewport bottom (1). Written
      // straight to the DOM rather than React state so it tracks every scroll
      // frame without a re-render.
      if (emphasis === "watch-rail") {
        const firstTop = sectionNodes[0].getBoundingClientRect().top + window.scrollY;
        const lastBottom = sectionNodes[sectionNodes.length - 1].getBoundingClientRect().bottom + window.scrollY;
        const start = firstTop - getScrollOffset(railNode, stickyOffsetPx);
        const end = lastBottom - window.innerHeight;
        const span = end - start;
        const progress = span > 0 ? (window.scrollY - start) / span : window.scrollY >= start ? 1 : 0;
        railNode.style.setProperty("--pharos-read-progress", String(Math.min(1, Math.max(0, progress))));
      }
    };

    applyScrollMargins();
    computeActiveSection();

    // Recompute on layout changes, not just scroll: this page lazy-mounts
    // charts whose late render shifts section offsets, and hash jumps can land
    // the reader mid-page before that settles. Observing the document body
    // keeps the lit pill correct without waiting for the next scroll event.
    const resizeObserver = new ResizeObserver(() => {
      applyScrollMargins();
      computeActiveSection();
    });
    resizeObserver.observe(railNode);
    if (document.body) resizeObserver.observe(document.body);
    window.addEventListener("resize", applyScrollMargins);

    const handleScroll = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        computeActiveSection();
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    const activeHash = getHashSectionId();
    if (!initialHashHandledRef.current) {
      initialHashHandledRef.current = true;
      if (activeHash.length > 0 && sectionNodes.some((node) => node.id === activeHash)) {
        requestAnimationFrame(() => {
          applyScrollMargins();
          setActiveId(activeHash);
          scheduleSectionAlignment(activeHash, railNode, pendingScrollSyncRef, false, stickyOffsetPx);
        });
      }
    }

    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", applyScrollMargins);
      clearPendingScrollSync(pendingScrollSyncRef);
      for (const node of sectionNodes) {
        node.style.scrollMarginTop = "";
      }
    };
  }, [sectionSignature, emphasis, stickyOffsetPx]);

  if (sections.length === 0) return null;

  if (variant === "rail") {
    return (
      <div
        ref={railRef}
        className={cn("sticky top-[calc(env(safe-area-inset-top)+4.5rem)] w-[14rem] self-start", className)}
        style={stickyOffsetPx == null ? undefined : { top: stickyOffsetPx }}
      >
        <p className="px-2 pb-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {railLabel}
        </p>
        <nav aria-label={navAriaLabel}>
          <ul className="flex flex-col gap-px border-l border-border/60">
            {sections.map((section) => {
              const isActive = effectiveActiveId === section.id;
              return (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      scheduleSectionAlignment(section.id, railRef.current, pendingScrollSyncRef, true, stickyOffsetPx);
                      setActiveId(section.id);
                    }}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "pharos-focus-ring relative -ml-px block truncate border-l py-1.5 pl-3 pr-2 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors",
                      isActive
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                    )}
                  >
                    {section.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    );
  }

  const isPillTabs = emphasis === "pill-tabs";

  return (
    <>
      <div
        ref={railRef}
        className={cn(
          "sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 md:mx-0 lg:top-[calc(env(safe-area-inset-top)+3px)]",
          isPillTabs
            ? "mx-0 bg-transparent px-0 py-0"
            : "-mx-4 rounded-xl border border-border/60 bg-background px-3 py-2 md:px-4 md:py-2.5",
          emphasis === "watch-rail" && "pharos-watch-rail overflow-hidden",
          className,
        )}
        style={stickyOffsetPx == null ? undefined : { top: stickyOffsetPx }}
      >
        <div className={cn("relative flex items-center", isPillTabs ? "justify-center gap-2" : "gap-3")}>
          {/* Fade mask hints at off-screen pills on narrow viewports */}
          <div
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background to-transparent sm:hidden"
            aria-hidden="true"
          />
          {isPillTabs ? (
            <span
              aria-hidden="true"
              className="pharos-pill-tabs-rule pharos-pill-tabs-rule-left hidden h-px w-28 shrink-0 lg:block xl:w-36 2xl:w-44"
            />
          ) : null}
          <nav
            ref={bannerScrollerRef}
            aria-label={navAriaLabel}
            className={cn(
              "scrollbar-none overflow-x-auto",
              isPillTabs ? "pharos-pill-tabs-group max-w-full px-0.5 py-px" : "min-w-0 flex-1 -mx-1 px-1 pb-0.5",
            )}
          >
            <div
              className={cn("flex min-w-max snap-x snap-mandatory items-center", isPillTabs ? "gap-0.5" : "gap-1.5")}
            >
              {sections.map((section) => {
                const Icon = section.icon;
                const isActive = effectiveActiveId === section.id;
                return (
                  <a
                    key={section.id}
                    ref={isActive ? activeAnchorRef : undefined}
                    href={`#${section.id}`}
                    aria-current={isActive ? "true" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      scheduleSectionAlignment(section.id, railRef.current, pendingScrollSyncRef, true, stickyOffsetPx);
                      setActiveId(section.id);
                    }}
                    className={cn(
                      "group pharos-focus-ring relative isolate inline-flex shrink-0 snap-start items-center overflow-hidden whitespace-nowrap font-medium transition-colors",
                      isPillTabs
                        ? "min-h-11 gap-1.5 rounded-[7px] px-3.5 py-1 text-sm leading-none md:h-7 md:min-h-0"
                        : "min-h-11 gap-1.5 rounded-full px-3 py-1.5 text-xs md:min-h-8 md:text-sm",
                      isPillTabs ? "pharos-pill-tab" : "pharos-rail-tab",
                      isPillTabs && isActive && "pharos-pill-tab-active",
                      !isPillTabs && isActive && "pharos-rail-tab-active",
                      emphasis === "watch-rail" && isActive && "font-semibold",
                    )}
                  >
                    {!isPillTabs && isActive ? <span aria-hidden className="pharos-nav-beam" /> : null}
                    {Icon ? (
                      <Icon
                        aria-hidden
                        className={cn(
                          "shrink-0",
                          isPillTabs
                            ? "h-4 w-4 text-current"
                            : cn(
                                "h-3.5 w-3.5",
                                isActive ? "text-frost-blue" : "text-muted-foreground/80 group-hover:text-foreground",
                              ),
                        )}
                      />
                    ) : null}
                    <span>{section.label}</span>
                  </a>
                );
              })}
            </div>
          </nav>
          {isPillTabs ? (
            <span
              aria-hidden="true"
              className="pharos-pill-tabs-rule pharos-pill-tabs-rule-right hidden h-px w-28 shrink-0 lg:block xl:w-36 2xl:w-44"
            />
          ) : null}
          {rightSlot && <div className="hidden shrink-0 sm:block">{rightSlot}</div>}
        </div>
        {emphasis === "watch-rail" && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-frost-blue"
            style={{ transform: "scaleX(var(--pharos-read-progress, 0))" }}
            aria-hidden="true"
          />
        )}
      </div>
      {showDepthHint && (
        <div
          className="pointer-events-none h-6 bg-gradient-to-b from-border/20 to-transparent motion-safe:animate-[pharos-fade-in-up_220ms_var(--motion-ease-standard)_both]"
          aria-hidden="true"
        />
      )}
    </>
  );
}
