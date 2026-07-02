"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Tracks an element's border-box width via ResizeObserver, using a callback
 * ref so it survives the element being swapped (e.g. a loading frame replaced
 * by the loaded frame). Returns 0 until a node mounts and is measured. In
 * environments without ResizeObserver (jsdom), measures once per attach and
 * never updates.
 */
export function useElementWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number,
] {
  const observerRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) return;

    const publish = () => {
      const next = Math.round(node.clientWidth);
      setWidth((prev) => (prev === next ? prev : next));
    };

    publish();
    if (typeof ResizeObserver === "undefined") return;

    observerRef.current = new ResizeObserver(publish);
    observerRef.current.observe(node);
  }, []);

  return [ref, width];
}
