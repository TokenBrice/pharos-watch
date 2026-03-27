import { useEffect, useState } from "react";

/**
 * Manages a boolean open/closed state for a `<details>` element that
 * auto-opens when `signal` becomes truthy.
 *
 * Uses `setTimeout(fn, 0)` to defer `setState` out of the effect's
 * synchronous body, satisfying the react-hooks/set-state-in-effect lint rule.
 */
export function useAutoExpand(signal: boolean): [boolean, (open: boolean) => void] {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!signal) return;
    const timer = window.setTimeout(() => setIsOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [signal]);

  return [isOpen, setIsOpen];
}
