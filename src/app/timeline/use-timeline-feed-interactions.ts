"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { eventDomId, HIGHLIGHT_DURATION_MS } from "./timeline-feed-helpers";

interface UseTimelineFeedInteractionsArgs {
  filterSignature: string;
  permalinkId: string;
  permalinkResolved: boolean;
  loadedCount: number;
  total: number | null;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}
export function useTimelineFeedInteractions({
  filterSignature,
  permalinkId,
  permalinkResolved,
  loadedCount,
  total,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
}: UseTimelineFeedInteractionsArgs) {
  const [autoLoadState, setAutoLoadState] = useState<{ filterSignature: string; enabled: boolean } | null>(null);
  const autoLoadEnabled =
    autoLoadState?.filterSignature === filterSignature
      ? autoLoadState.enabled
      : false;
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // Sr-only announcer for Load More results. We don't `aria-live` the whole
  // feed wrapper because every paginated page would re-flood the queue.
  // Instead, surface a concise summary that only updates when the visible
  // count actually changes.
  const [loadAnnouncementState, setLoadAnnouncementState] = useState<{ filterSignature: string; message: string } | null>(null);
  const loadAnnouncement =
    loadAnnouncementState?.filterSignature === filterSignature
      ? loadAnnouncementState.message
      : "";
  const prevVisibleCountRef = useRef<{ filterSignature: string; count: number } | null>(null);

  useEffect(() => {
    if (!permalinkResolved || !permalinkId) {
      return undefined;
    }
    if (typeof window === "undefined") return undefined;
    let timeoutId: number | undefined;
    const rafId = window.requestAnimationFrame(() => {
      setHighlightedId(permalinkId);
      // Expand any <details> ancestor of the target so the row is visible.
      const el = document.getElementById(eventDomId(permalinkId));
      if (el) {
        let parent: HTMLElement | null = el.parentElement;
        while (parent) {
          if (parent.tagName === "DETAILS") {
            (parent as HTMLDetailsElement).open = true;
          }
          parent = parent.parentElement;
        }
        if (typeof el.scrollIntoView === "function") {
          // WCAG 2.3.3 — honor `prefers-reduced-motion` by skipping the
          // smooth scroll animation when the user has requested less motion.
          const prefersReducedMotion =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollIntoView({
            behavior: prefersReducedMotion ? "auto" : "smooth",
            block: "center",
          });
        }
        // WCAG 2.4.3 — move keyboard / AT focus to the permalink target so
        // screen-reader users land on the row instead of staying at the top.
        if (typeof (el as HTMLElement).focus === "function") {
          (el as HTMLElement).focus({ preventScroll: true });
        }
      }
      timeoutId = window.setTimeout(() => {
        setHighlightedId((current) => (current === permalinkId ? null : current));
      }, HIGHLIGHT_DURATION_MS);
    });
    return () => {
      window.cancelAnimationFrame(rafId);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [permalinkResolved, permalinkId]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoLoadEnabled) return;
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) {
            void fetchNextPage();
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [autoLoadEnabled, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const handleLoadMore = useCallback(() => {
    setAutoLoadState({ filterSignature, enabled: true });
    void fetchNextPage();
  }, [filterSignature, fetchNextPage]);

  useEffect(() => {
    const prev =
      prevVisibleCountRef.current?.filterSignature === filterSignature
        ? prevVisibleCountRef.current.count
        : null;
    if (prev != null && loadedCount > prev) {
      const delta = loadedCount - prev;
      const ofTotal = total != null ? ` ${loadedCount} of ${total} shown.` : "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the aria-live text is derived from the committed page count delta.
      setLoadAnnouncementState({
        filterSignature,
        message: `Loaded ${delta} more event${delta === 1 ? "" : "s"}.${ofTotal}`,
      });
    }
    prevVisibleCountRef.current = { filterSignature, count: loadedCount };
  }, [filterSignature, loadedCount, total]);

  return {
    highlightedId,
    loadAnnouncement,
    sentinelRef,
    handleLoadMore,
  };
}
