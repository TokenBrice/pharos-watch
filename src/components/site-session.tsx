"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SiteSessionRequiredError } from "@/lib/api";
import { CoinNotices } from "@/components/coin-notice";
import { isSiteSessionCheckEnabled } from "@/lib/feature-flags";
import { loadSiteSessionScript, preloadSiteSessionScript } from "@/lib/site-session-script";
import {
  isSiteSessionPaused,
  registerSiteSessionRecovery,
  registerSiteSessionChallenge,
  renewSiteSessionIfNeeded,
  subscribeSiteSession,
} from "@/lib/site-session-client";

interface Turnstile {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    appearance: "interaction-only";
    execution: "render";
    retry: "never";
    "refresh-expired": "never";
    "refresh-timeout": "never";
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
    "timeout-callback": () => void;
  }): string;
  remove(id: string): void;
}

declare global {
  interface Window { turnstile?: Turnstile; }
}

function SessionCheck() {
  const container = useRef<HTMLDivElement>(null);
  const paused = useSyncExternalStore(subscribeSiteSession, isSiteSessionPaused, () => false);
  const queryClient = useQueryClient();

  useEffect(() => registerSiteSessionRecovery(() => {
    void queryClient.refetchQueries({
      type: "active", predicate: (query) => query.state.error instanceof SiteSessionRequiredError,
    });
  }), [queryClient]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    preloadSiteSessionScript();
    let cancelWidget: (() => void) | undefined;
    const unregister = registerSiteSessionChallenge((signal) => new Promise<string>((resolve, reject) => {
      // A valid session never invokes the challenge until renewal is due.
      const script = loadSiteSessionScript();
      let widget: string | undefined;
      const cleanup = () => {
        script.removeEventListener("load", render);
        script.removeEventListener("error", fail);
        signal.removeEventListener("abort", fail);
        if (widget !== undefined) window.turnstile?.remove(widget);
        cancelWidget = undefined;
      };
      const fail = () => { cleanup(); reject(new Error("Browser check did not complete")); };
      const render = () => {
        if (!window.turnstile) { fail(); return; }
        try {
          widget = window.turnstile.render(host, {
            sitekey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!.trim(),
            action: "site-data",
            appearance: "interaction-only",
            execution: "render",
            retry: "never",
            "refresh-expired": "never",
            "refresh-timeout": "never",
            callback: (token) => { cleanup(); resolve(token); },
            "error-callback": fail,
            "expired-callback": fail,
            "timeout-callback": fail,
          });
        } catch { fail(); }
      };
      cancelWidget = fail;
      signal.addEventListener("abort", fail, { once: true });
      if (signal.aborted || script.dataset.failed) fail();
      else if (window.turnstile) render();
      else {
        script.addEventListener("load", render, { once: true });
        script.addEventListener("error", fail, { once: true });
      }
    }));
    renewSiteSessionIfNeeded();
    const timer = setInterval(renewSiteSessionIfNeeded, 60_000);
    document.addEventListener("visibilitychange", renewSiteSessionIfNeeded);
    return () => {
      unregister();
      cancelWidget?.();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renewSiteSessionIfNeeded);
    };
  }, []);

  return (
    <>
      <div ref={container} className="fixed bottom-4 right-4 z-toast" />
      {paused && (
        <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-toast mx-auto max-w-xl">
          <CoinNotices notices={[{
            type: "warning",
            title: "",
            message: "Live data is paused: the browser check did not complete. Reload to try again.",
          }]} />
        </div>
      )}
    </>
  );
}

export function SiteSession() {
  return isSiteSessionCheckEnabled() ? <SessionCheck /> : null;
}
