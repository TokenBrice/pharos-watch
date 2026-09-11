"use client";

import { useCallback, useEffect, useRef } from "react";
import { clearPendingApiKey, retainPendingApiKey } from "@/components/pending-api-key-recovery";

/** Guard one-time secrets without writing them to browser storage. */
export function useUnsavedTokenGuard(token: string | null, secured: boolean, issuing = false) {
  const mounted = useRef(true);
  const detachPending = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      detachPending.current?.();
    };
  }, []);
  // Retain before setState: a claim can finish after its route has unmounted.
  const retainIssuedToken = useCallback((issuedToken: string) => {
    const detach = retainPendingApiKey(issuedToken);
    if (mounted.current) detachPending.current = detach;
    else detach();
  }, []);

  useEffect(() => {
    if (!token) return;
    if (secured) {
      clearPendingApiKey(token);
      return;
    }
    return retainPendingApiKey(token);
  }, [token, secured]);

  const unsaved = issuing || (Boolean(token) && !secured);
  useEffect(() => {
    if (!unsaved) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handleLinkClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return; // Full navigations use beforeunload.
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm(issuing ? "Your API key is being issued. Leave this page?" : "Your API key is only shown once. Leave without saving it?")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    // Capture before React/Next Link can start a client-side transition.
    document.addEventListener("click", handleLinkClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleLinkClick, true);
    };
  }, [unsaved, issuing]);
  return retainIssuedToken;
}
