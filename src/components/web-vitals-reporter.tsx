"use client";

import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { trackEvent } from "@/lib/analytics";

type WebVitalMetric = {
  name: "CLS" | "FCP" | "INP" | "LCP" | "TTFB" | "FID" | "Next.js-hydration" | "Next.js-route-change-to-render" | "Next.js-render";
  value: number;
  id: string;
  rating?: "good" | "needs-improvement" | "poor";
  navigationType?: string;
};

export function WebVitalsReporter() {
  const pathname = usePathname();

  useReportWebVitals((metric: WebVitalMetric) => {
    trackEvent("web_vital", {
      name: metric.name,
      value: metric.value,
      id: metric.id,
      rating: metric.rating ?? "good",
      navigation_type: metric.navigationType ?? "navigate",
      page_path: pathname ?? "",
    });
  });

  return null;
}
