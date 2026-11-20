"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";
import { SafetyMapImageProvider } from "./map-preview";

type LiveClient = ComponentType<{ initialPreview: SafetyScoresPreview | null; onHandoff?: () => void }>;

/**
 * Shows the server-rendered first flush (`children`: hero, LCP map teaser and
 * dated preview) until the live client has something different to show. Its
 * chunk is requested after hydration, keeping the image preload in the first flush.
 */
export function SafetyScoresLiveIsland({
  initialPreview,
  children,
}: {
  initialPreview: SafetyScoresPreview | null;
  children: ReactNode;
}) {
  const [Live, setLive] = useState<LiveClient | null>(null);
  const [showServerContent, setShowServerContent] = useState(true);
  const content = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);
  const handoff = useCallback(() => {
    const active = document.activeElement;
    previousFocus.current = content.current?.contains(active) ? active : null;
    setShowServerContent(false);
  }, []);
  useLayoutEffect(() => {
    const active = previousFocus.current;
    previousFocus.current = null;
    const region = content.current;
    if (showServerContent || !active || !region || document.activeElement !== document.body) return;
    const href = active.getAttribute("href");
    const replacement = Array.from(region.querySelectorAll("a[href]")).find((link) => link.getAttribute("href") === href)
      ?? region.querySelector("#data")
      ?? region.querySelector("a[href='/safety-scores/map/']");
    if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
  }, [showServerContent]);

  useEffect(() => {
    let active = true;
    import("./v9-client").then(
      (module) => {
        if (active) setLive(() => module.ReportCardsV9Client);
      },
      // A chunk that cannot load is a section failure: hand it to the error boundary.
      (error: unknown) => {
        if (active) setLive(() => () => { throw error; });
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <SafetyMapImageProvider>
      <div ref={content} className="space-y-6">
        {showServerContent ? children : null}
        {Live ? <Live initialPreview={initialPreview} onHandoff={showServerContent ? handoff : undefined} /> : null}
      </div>
    </SafetyMapImageProvider>
  );
}
