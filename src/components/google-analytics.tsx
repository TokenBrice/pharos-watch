"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    dataLayer?: unknown[][];
    gtag?: (...args: unknown[]) => void;
  }
}

interface GoogleAnalyticsProps {
  measurementId: string;
}

export function GoogleAnalytics({ measurementId }: GoogleAnalyticsProps) {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    window.dataLayer = window.dataLayer ?? [];
    window.gtag = (...args: unknown[]) => {
      window.dataLayer?.push(args);
    };

    const pagePath = window.location.pathname + window.location.search;
    window.gtag("js", new Date());
    const sendPageView = () => {
      window.gtag?.("config", measurementId, { send_page_view: false });
      window.gtag?.("event", "page_view", {
        page_path: pagePath,
        page_location: window.location.origin + pagePath,
        page_title: document.title,
      });
    };

    const existingScript = document.getElementById("pharos-google-analytics");
    if (existingScript) {
      sendPageView();
    } else {
      const script = document.createElement("script");
      script.id = "pharos-google-analytics";
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
      script.addEventListener("load", sendPageView, { once: true });
      document.head.appendChild(script);
    }
  }, [measurementId]);

  return null;
}
