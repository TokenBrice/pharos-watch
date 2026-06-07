"use client";

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

interface ChartContainerSize {
  width: number;
  height: number;
}

function normalizeSize(width: number, height: number): ChartContainerSize {
  return {
    width: Math.max(0, Math.floor(width)),
    height: Math.max(0, Math.floor(height)),
  };
}

function publishSize(
  setSize: Dispatch<SetStateAction<ChartContainerSize>>,
  next: ChartContainerSize,
): void {
  setSize((prev) => (
    prev.width === next.width && prev.height === next.height ? prev : next
  ));
}

export function useChartContainerReady<T extends HTMLElement>() {
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (frameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (!node) {
      publishSize(setSize, { width: 0, height: 0 });
      return;
    }

    const publishFromNode = () => {
      publishSize(setSize, normalizeSize(node.clientWidth, node.clientHeight));
    };

    if (typeof ResizeObserver === "undefined") {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        publishFromNode();
      });
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === node) ?? entries[0];
      if (!entry) return;
      publishSize(setSize, normalizeSize(entry.contentRect.width, entry.contentRect.height));
    });
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
