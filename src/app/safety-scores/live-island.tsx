"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";

type LiveClient = ComponentType<{ initialPreview?: SafetyScoresPreview | null }>;

/**
 * Shows the server-rendered first flush (`children`: hero, LCP map teaser and
 * dated preview) until the live client arrives. Its chunk is requested only
 * after hydration, so it never competes with the preloaded hero image. The live
 * client's pending branch renders the same tree, so the swap is one commit
 * before paint with no markup change.
 */
export function SafetyScoresLiveIsland({
  initialPreview,
  children,
}: {
  initialPreview: SafetyScoresPreview | null;
  children: ReactNode;
}) {
  const [Live, setLive] = useState<LiveClient | null>(null);
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
  return Live ? <Live initialPreview={initialPreview} /> : children;
}
