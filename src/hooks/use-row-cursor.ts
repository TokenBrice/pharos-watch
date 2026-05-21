"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Virtualizer } from "@tanstack/react-virtual";

export interface UseRowCursorOptions<T> {
  rows: readonly T[];
  virtualizer?: Virtualizer<HTMLElement, Element> | null;
  getRowId: (row: T) => string;
  onOpen?: (row: T) => void;
  onToggleStar?: (row: T) => void;
  onAddToCompare?: (row: T) => void;
  enabled?: boolean;
  scopeRef?: React.RefObject<HTMLElement>;
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

  const rowsLength = rows.length;

  // Reset cursor when row set changes meaningfully (e.g., filters reduce the list past the current index).
  const prevLengthRef = useRef(rowsLength);
  useEffect(() => {
    if (prevLengthRef.current !== rowsLength) {
      prevLengthRef.current = rowsLength;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCursorIndexState((current) => {
        if (rowsLength === 0) return 0;
        if (current >= rowsLength) return 0;
        return current;
      });
    }
  }, [rowsLength]);

  const setCursorIndex = useCallback(
    (i: number) => {
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
    if (!virtualizer) return;
    if (rowsLength === 0) return;
    virtualizer.scrollToIndex(cursorIndex);
  }, [cursorIndex, rowsLength, virtualizer]);

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
        setCursorIndexState((current) => Math.min(rowsLength - 1, current + 1));
        return;
      }
      if (key === "k" || key === "ArrowUp") {
        event.preventDefault();
        setCursorIndexState((current) => Math.max(0, current - 1));
        return;
      }
      if (key === "o" || key === "Enter") {
        if (!onOpen) return;
        event.preventDefault();
        const row = rows[cursorIndex];
        if (row) onOpen(row);
        return;
      }
      if (key === "s") {
        if (!onToggleStar) return;
        event.preventDefault();
        const row = rows[cursorIndex];
        if (row) onToggleStar(row);
        return;
      }
      if (key === "c") {
        if (!onAddToCompare) return;
        event.preventDefault();
        const row = rows[cursorIndex];
        if (row) onAddToCompare(row);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    cursorIndex,
    enabled,
    onAddToCompare,
    onOpen,
    onToggleStar,
    rows,
    rowsLength,
    scopeRef,
  ]);

  const cursorRow = rowsLength > 0 && cursorIndex < rowsLength ? rows[cursorIndex] : null;
  const cursorId = cursorRow ? getRowId(cursorRow) : null;

  const getRowProps = useCallback(
    (index: number, _rowId: string) => {
      const isCursor = index === cursorIndex;
      return {
        ...(isCursor ? { "data-cursor": "true" as const, tabIndex: 0 } : {}),
        onMouseEnter: () => {
          setCursorIndexState((current) => (current === index ? current : index));
        },
      };
    },
    [cursorIndex],
  );

  return {
    cursorIndex,
    cursorId,
    setCursorIndex,
    getRowProps,
  };
}
