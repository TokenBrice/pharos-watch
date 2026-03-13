"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

export const ADMIN_KEY_IDLE_TIMEOUT_MINUTES = 15;
const ADMIN_KEY_IDLE_TIMEOUT_MS = ADMIN_KEY_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const ADMIN_QUERY_KEYS = [
  ["status"],
  ["status-history"],
  ["endpoint-probes"],
] as const;

export function useAdminSessionKey() {
  const queryClient = useQueryClient();
  const [adminKey, setAdminKey] = useState("");
  const [adminSessionRevision, setAdminSessionRevision] = useState(0);
  const [lastExitReason, setLastExitReason] = useState<"expired" | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const clearAdminQueries = useCallback(() => {
    for (const queryKey of ADMIN_QUERY_KEYS) {
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    }
  }, [queryClient]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current != null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    clearIdleTimer();
    if (!adminKey) return;

    idleTimerRef.current = window.setTimeout(() => {
      clearAdminQueries();
      setAdminKey("");
      setLastExitReason("expired");
    }, ADMIN_KEY_IDLE_TIMEOUT_MS);
  }, [adminKey, clearAdminQueries, clearIdleTimer]);

  const handleKeySubmit = useCallback((key: string) => {
    clearAdminQueries();
    setAdminKey(key);
    setAdminSessionRevision((current) => current + 1);
    setLastExitReason(null);
  }, [clearAdminQueries]);

  const handleSignOut = useCallback(() => {
    clearIdleTimer();
    clearAdminQueries();
    setAdminKey("");
    setLastExitReason(null);
  }, [clearAdminQueries, clearIdleTimer]);

  useEffect(() => {
    if (!adminKey) {
      clearIdleTimer();
      return;
    }

    const handleActivity = () => {
      resetIdleTimer();
    };

    resetIdleTimer();

    window.addEventListener("pointerdown", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("scroll", handleActivity, { passive: true });
    window.addEventListener("focus", handleActivity);

    return () => {
      clearIdleTimer();
      window.removeEventListener("pointerdown", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("scroll", handleActivity);
      window.removeEventListener("focus", handleActivity);
    };
  }, [adminKey, clearIdleTimer, resetIdleTimer]);

  return {
    adminKey,
    adminSessionRevision,
    handleKeySubmit,
    handleSignOut,
    idleTimeoutMinutes: ADMIN_KEY_IDLE_TIMEOUT_MINUTES,
    lastExitReason,
  };
}
