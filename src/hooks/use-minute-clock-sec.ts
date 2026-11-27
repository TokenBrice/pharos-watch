"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getOpenIncidentHorizonCrossingKey } from "@shared/lib/active-depegs";
import type { OpenIncidentSnapshot } from "@shared/types/peg";

/**
 * Hydration-safe minute clock: zero (no evidence, no age) until mounted, then
 * the viewer's clock — never query receipt time, which freezes between polls.
 */
export function useMinuteClockSec(): number {
  const [nowSec, setNowSec] = useState(0);
  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    const timer = setTimeout(tick, 0);
    const interval = setInterval(tick, 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);
  return nowSec;
}

/**
 * Revalidates the shared `/api/peg-summary` query once whenever a displayed open-incident
 * representative crosses a horizon boundary (`recent`/`escalating` -> `long_running`) on
 * the live minute clock so multi-event coins pick the server's next representative instead
 * of flashing into the wrong segment before the next polling interval.
 *
 * Returns the effective horizon assessment clock: holds `asOfSec` while the boundary
 * revalidation is in flight, uses `clockSec` once a post-boundary `asOfSec` arrives, and
 * fails closed (`0` -> split unavailable) if revalidation settles without one (error or
 * cached pre-boundary response) or when no `refetch` callback is available.
 */
export function useOpenIncidentHorizonClock(
  openIncidents: Readonly<Record<string, OpenIncidentSnapshot>> | null | undefined,
  asOfSec: number | null | undefined,
  clockSec: number,
  refetch?: (options?: { cancelRefetch?: boolean }) => Promise<unknown>,
): number {
  const crossingKey = useMemo(
    () => getOpenIncidentHorizonCrossingKey(openIncidents, asOfSec, clockSec),
    [openIncidents, asOfSec, clockSec],
  );
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const inFlightRef = useRef<{ key: string; promise: Promise<unknown> } | null>(null);

  useEffect(() => {
    if (!crossingKey) {
      inFlightRef.current = null;
      return;
    }
    if (!refetch) return;
    let entry = inFlightRef.current;
    if (!entry || entry.key !== crossingKey) {
      const promise = Promise.resolve(refetch({ cancelRefetch: false })).catch(() => undefined);
      entry = { key: crossingKey, promise };
      inFlightRef.current = entry;
    }
    let active = true;
    void entry.promise.finally(() => {
      if (active) setSettledKey(crossingKey);
    });
    return () => {
      active = false;
    };
  }, [crossingKey, refetch]);

  if (!crossingKey) return clockSec;
  if (refetch && settledKey !== crossingKey && asOfSec != null && asOfSec > 0) {
    return asOfSec;
  }
  return 0;
}
