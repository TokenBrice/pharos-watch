"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

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

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

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

    if (!document.getElementById("pharos-google-analytics")) {
      const script = document.createElement("script");
      script.id = "pharos-google-analytics";
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
      document.head.appendChild(script);
    }
  }, [measurementId]);

  useEffect(() => {
    if (typeof window === "undefined" || !pathname) return;
    const search = window.location.search ?? "";
    const pagePath = pathname + search;
    window.gtag?.("event", "page_view", {
      page_path: pagePath,
      page_location: window.location.origin + pagePath,
      page_title: document.title,
    });
  }, [pathname]);

  return null;
}
