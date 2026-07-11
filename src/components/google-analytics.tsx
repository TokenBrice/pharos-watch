"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { clearAllTrackingTimers } from "@/lib/analytics";
import { stripQueryVerificationTokenFromUrl } from "@/lib/api-key-verification-url";
import { scheduleIdle } from "@/lib/browser-utils";
import { isTelegramMiniAppPath } from "@shared/lib/site-csp";

declare global {
  interface Window {
    dataLayer?: Array<IArguments | unknown[]>;
    gtag?: (...args: unknown[]) => void;
  }
}

interface GoogleAnalyticsProps {
  measurementId: string;
}

export function GoogleAnalytics({ measurementId }: GoogleAnalyticsProps) {
  const pathname = usePathname();
  const bootstrapped = useRef(false);
  const analyticsAllowed = Boolean(pathname) && !isTelegramMiniAppPath(pathname ?? "");

  useEffect(() => {
    if (!analyticsAllowed) return;

    if (!bootstrapped.current) {
      bootstrapped.current = true;

      // The lightweight gtag stub + dataLayer queue is installed synchronously so
      // `window.gtag(...)` calls (consent, config, page_view) are buffered from the
      // first render. Only the ~160KB gtag.js download + execution is deferred to
      // an idle window, keeping its two long tasks off the LCP/TBT critical path;
      // the queued commands replay once the script processes the dataLayer.
      window.dataLayer = window.dataLayer ?? [];
      window.gtag = function gtag() {
        // Match Google's standard snippet: gtag.js processes native arguments entries, not rest-parameter arrays.
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer?.push(arguments);
      };
      window.gtag("consent", "default", {
        ad_storage: "denied",
        analytics_storage: "granted",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
      window.gtag("js", new Date());
      window.gtag("config", measurementId, { send_page_view: false });
    }

    return scheduleIdle(() => {
      if (document.getElementById("pharos-google-analytics")) return;
      const script = document.createElement("script");
      script.id = "pharos-google-analytics";
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
      document.head.appendChild(script);
    }, 2_000);
  }, [analyticsAllowed, measurementId]);

  useEffect(() => {
    if (typeof window === "undefined" || !pathname || !analyticsAllowed) {
      clearAllTrackingTimers();
      return;
    }
    // Cancel any debounced search timer from the previous route so it cannot
    // fire a search_performed event attributed to the page we just left.
    clearAllTrackingTimers();
    stripQueryVerificationTokenFromUrl();
    const search = window.location.search ?? "";
    const pagePath = pathname + search;
    window.gtag?.("event", "page_view", {
      page_path: pagePath,
      page_location: window.location.origin + pagePath,
      page_title: document.title,
    });
  }, [analyticsAllowed, pathname]);

  return null;
}
