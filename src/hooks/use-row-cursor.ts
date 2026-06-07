"use client";

import { useCallback, useEffect, useState } from "react";
import { type Virtualizer } from "@tanstack/react-virtual";

export interface UseRowCursorOptions<T> {
  rows: readonly T[];
  virtualizer?: Virtualizer<HTMLElement, Element> | null;
  getRowId: (row: T) => string;
  onOpen?: (row: T) => void;
  onToggleStar?: (row: T) => void;
  onAddToCompare?: (row: T) => void;
  enabled?: boolean;
  scopeRef?: React.RefObject<HTMLElement | null>;
}

export interface UseRowCursorResult {
  cursorIndex: number;
  cursorId: string | null;
  setCursorIndex: (i: number) => void;
  getRowProps: (index: number, rowId: string) => {
    "data-cursor"?: "true";
    tabIndex?: number;
    onMouseEnter?: () => void;
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useRowCursor<T>(opts: UseRowCursorOptions<T>): UseRowCursorResult {
  const {
    rows,
    virtualizer,
    getRowId,
    onOpen,
    onToggleStar,
    onAddToCompare,
    enabled = true,
    scopeRef,
  } = opts;

  const [cursorIndex, setCursorIndexState] = useState(0);
  const [cursorActive, setCursorActive] = useState(false);

  const rowsLength = rows.length;
  const cursorIndexBounded = rowsLength === 0 ? 0 : Math.min(cursorIndex, rowsLength - 1);

  const setCursorIndex = useCallback(
    (i: number) => {
      setCursorActive(rowsLength > 0);
      setCursorIndexState((current) => {
        if (rowsLength === 0) return 0;
        const next = Math.max(0, Math.min(rowsLength - 1, i));
        if (next === current) return current;
        return next;
      });
    },
    [rowsLength],
  );

  // Scroll virtualizer to the cursor when it moves.
  useEffect(() => {
    if (!cursorActive) return;
    if (!virtualizer) return;
    if (rowsLength === 0) return;
    const virtualItems = virtualizer.getVirtualItems();
    if (virtualItems.length > 0) {
      const firstIndex = virtualItems[0].index;
      const lastIndex = virtualItems[virtualItems.length - 1].index;
      if (cursorIndexBounded >= firstIndex && cursorIndexBounded <= lastIndex) return;
    }
    virtualizer.scrollToIndex(cursorIndexBounded);
  }, [cursorActive, cursorIndexBounded, rowsLength, virtualizer]);

  // Keyboard handler
  useEffect(() => {
    if (!enabled) return;
    if (rowsLength === 0) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      // If scoped, only act when the scope contains the activeElement.
      const scopeEl = scopeRef?.current;
      if (scopeEl) {
        const active = document.activeElement;
        if (active && !scopeEl.contains(active)) return;
      }

      const key = event.key;

      if (key === "j" || key === "ArrowDown") {
        event.preventDefault();
        setCursorActive(true);
        setCursorIndexState((current) => Math.min(rowsLength - 1, current + 1));
        return;
      }
      if (key === "k" || key === "ArrowUp") {
        event.preventDefault();
        setCursorActive(true);
        setCursorIndexState((current) => Math.max(0, current - 1));
        return;
      }
      if (key === "o" || key === "Enter") {
        if (!onOpen) return;
        event.preventDefault();
        setCursorActive(true);
        const row = rows[cursorIndexBounded];
        if (row) onOpen(row);
        return;
      }
      if (key === "s") {
        if (!onToggleStar) return;
        event.preventDefault();
        setCursorActive(true);
        const row = rows[cursorIndexBounded];
        if (row) onToggleStar(row);
        return;
      }
      if (key === "c") {
        if (!onAddToCompare) return;
        event.preventDefault();
        setCursorActive(true);
        const row = rows[cursorIndexBounded];
        if (row) onAddToCompare(row);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    cursorIndexBounded,
    enabled,
    onAddToCompare,
    onOpen,
    onToggleStar,
    rows,
    rowsLength,
    scopeRef,
  ]);

  const cursorRow = rowsLength > 0 ? rows[cursorIndexBounded] : null;
  const cursorId = cursorRow ? getRowId(cursorRow) : null;

  const getRowProps = useCallback(
    (index: number, _rowId: string) => {
      if (!enabled) return {};
      const isCursor = cursorActive && index === cursorIndexBounded;
      return {
        ...(isCursor ? { "data-cursor": "true" as const, tabIndex: 0 } : {}),
        onMouseEnter: () => {
          setCursorActive(true);
          setCursorIndex(index);
        },
      };
    },
    [cursorActive, cursorIndexBounded, enabled, setCursorIndex],
  );

  return {
    cursorIndex: cursorIndexBounded,
    cursorId,
    setCursorIndex,
    getRowProps,
  };
}
