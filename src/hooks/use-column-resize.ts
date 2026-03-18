"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { usePreference } from "./use-preferences";

interface ColumnWidth {
  [key: string]: number;
}

interface UseColumnResizeOptions {
  storageKey: string;
  defaultWidths: ColumnWidth;
  minWidth?: number;
  maxWidth?: number;
}

export function useColumnResize({
  storageKey,
  defaultWidths,
  minWidth = 60,
  maxWidth = 500,
}: UseColumnResizeOptions) {
  const [widths, setWidths, reset] = usePreference<ColumnWidth>(
    storageKey,
    defaultWidths
  );

  const [isResizing, setIsResizing] = useState(false);
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  const handleResizeStart = useCallback(
    (columnId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const currentWidth = widths[columnId] || defaultWidths[columnId] || 100;

      startXRef.current = e.clientX;
      startWidthRef.current = currentWidth;
      setResizingColumn(columnId);
      setIsResizing(true);

      // Add resize cursor to body
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [widths, defaultWidths]
  );

  useEffect(() => {
    if (!isResizing) return;

    function handleMouseMove(e: MouseEvent) {
      if (!resizingColumn) return;

      const delta = e.clientX - startXRef.current;
      const newWidth = Math.max(
        minWidth,
        Math.min(maxWidth, startWidthRef.current + delta)
      );

      setWidths((prev) => ({
        ...prev,
        [resizingColumn]: newWidth,
      }));
    }

    function handleMouseUp() {
      setIsResizing(false);
      setResizingColumn(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizingColumn, minWidth, maxWidth, setWidths]);

  const getWidth = useCallback(
    (columnId: string) => {
      return widths[columnId] || defaultWidths[columnId] || 100;
    },
    [widths, defaultWidths]
  );

  return {
    widths,
    getWidth,
    handleResizeStart,
    isResizing,
    resizingColumn,
    reset,
  };
}
