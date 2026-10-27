"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { clearAllTrackingTimers, isAnalyticsAllowed } from "@/lib/analytics";
import { stripQueryVerificationTokenFromUrl } from "@/lib/api-key-verification-url";
import { scheduleIdle } from "@/lib/browser-utils";

declare global {
  interface Window {
    dataLayer?: Array<IArguments | unknown[]>;
    gtag?: (...args: unknown[]) => void;
  }
}

// Query strings and fragments (e.g. shared portfolio holdings in `?p=`) must never reach GA.
function sanitizeReferrer(referrer: string): string {
  try {
    const url = new URL(referrer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

interface GoogleAnalyticsProps {
  measurementId: string;
}

export function GoogleAnalytics({ measurementId }: GoogleAnalyticsProps) {
  const pathname = usePathname();
  const bootstrapped = useRef(false);
  const lastLocation = useRef<string | null>(null);
  const analyticsAllowed = isAnalyticsAllowed(pathname);

  useEffect(() => {
    if (!analyticsAllowed) return;

    if (!bootstrapped.current) {
      bootstrapped.current = true;

      // The lightweight gtag stub + dataLayer queue is installed synchronously so
      // `window.gtag(...)` calls (consent, config, page_view) are buffered from the
      // first render. Only the ~160KB gtag.js download + execution is deferred to
      // an idle window after load so it cannot compete with load-blocking work;
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
      window.gtag("set", {
        page_location: window.location.origin + window.location.pathname,
        page_referrer: sanitizeReferrer(document.referrer),
      });
      window.gtag("config", measurementId, { send_page_view: false });
    }

    let cancelIdle: (() => void) | undefined;
    const scheduleAnalytics = () => {
      cancelIdle = scheduleIdle(() => {
        if (document.getElementById("pharos-google-analytics")) return;
        const script = document.createElement("script");
        script.id = "pharos-google-analytics";
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
        document.head.appendChild(script);
      }, { timeoutMs: 5_000, fallbackDelayMs: 5_000 });
    };
    if (document.readyState === "complete") scheduleAnalytics();
    else window.addEventListener("load", scheduleAnalytics, { once: true });
    return () => {
      window.removeEventListener("load", scheduleAnalytics);
      cancelIdle?.();
    };
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
    const pageLocation = window.location.origin + pathname;
    const pageReferrer = lastLocation.current ?? sanitizeReferrer(document.referrer);
    lastLocation.current = pageLocation;
    window.gtag?.("set", { page_location: pageLocation, page_referrer: pageReferrer });
    window.gtag?.("event", "page_view", {
      page_path: pathname,
      page_location: pageLocation,
      page_referrer: pageReferrer,
      page_title: document.title,
    });
  }, [analyticsAllowed, pathname]);

  return null;
}
