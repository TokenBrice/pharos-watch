"use client";

import { useEffect, useState } from "react";

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
