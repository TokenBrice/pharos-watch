"use client";

import { useEffect, useRef } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { isAnalyticsAllowed, trackEvent } from "@/lib/analytics";

type WebVitalMetric = {
  name: "CLS" | "FCP" | "INP" | "LCP" | "TTFB" | "FID" | "Next.js-hydration" | "Next.js-route-change-to-render" | "Next.js-render";
  value: number;
  id: string;
  rating?: "good" | "needs-improvement" | "poor";
  navigationType?: string;
};

export function WebVitalsReporter() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Inline arrow would capture `pathname` and re-subscribe `onCLS/onLCP/...`
  // on every render → duplicate GA events on client navigation. Reading the
  // ref keeps the callback identity stable across renders while still seeing
  // the latest path at metric-fire time.
  useReportWebVitals((metric: WebVitalMetric) => {
    if (!isAnalyticsAllowed(pathnameRef.current)) return;

    trackEvent("web_vital", {
      name: metric.name,
      value: metric.value,
      id: metric.id,
      rating: metric.rating ?? "good",
      navigation_type: metric.navigationType ?? "navigate",
      page_path: pathnameRef.current ?? "",
    });
  });

  return null;
}
