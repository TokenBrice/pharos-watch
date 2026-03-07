"use client";

import { useCallback, useRef, useState } from "react";

export function useChartContainerReady<T extends HTMLElement>() {
  const observerRef = useRef<ResizeObserver | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) {
      setSize({ width: 0, height: 0 });
      return;
    }

    const update = () => {
      setSize({
        width: Math.floor(node.clientWidth),
        height: Math.floor(node.clientHeight),
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  return {
    ref,
    ready: size.width > 0 && size.height > 0,
    width: size.width,
    height: size.height,
  };
}
