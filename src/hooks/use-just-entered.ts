import { useEffect, useRef, useState } from "react";

/**
 * Track which values just entered an array since the last render. Returns a
 * Set of values that became newly present, briefly so the consumer can apply
 * an entrance animation class. The set is cleared on a timeout after firing
 * so the class only renders once per addition.
 */
export function useJustEntered<T extends string>(current: readonly T[]): Set<T> {
  const previousRef = useRef<readonly T[]>(current);
  const [entered, setEntered] = useState<Set<T>>(() => new Set());

  useEffect(() => {
    const prev = previousRef.current;
    const next = current;
    if (prev === next) return;
    const prevSet = new Set(prev);
    const additions = next.filter((value) => !prevSet.has(value));
    previousRef.current = next;
    if (additions.length === 0) return;
    setEntered(new Set(additions));
    // 250ms is just past the 200ms chip-in keyframe — covers the animation
    // window without leaving the class hanging across later renders.
    const timer = window.setTimeout(() => setEntered(new Set()), 250);
    return () => window.clearTimeout(timer);
  }, [current]);

  return entered;
}
