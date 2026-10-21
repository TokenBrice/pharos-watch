"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { MiniAppPrimaryAction } from "./types";

type SetPrimaryAction = (action: MiniAppPrimaryAction | null) => void;

export const PrimaryActionContext = createContext<SetPrimaryAction>(() => {});

/**
 * Register the visible screen's single primary action. The shell renders it as
 * the Telegram MainButton; the click handler stays stable across renders so the
 * MainButton is not detached and re-attached on every keystroke.
 */
export function usePrimaryAction(action: MiniAppPrimaryAction | null): void {
  const setAction = useContext(PrimaryActionContext);
  const handlerRef = useRef<(() => void) | null>(null);
  const text = action?.text ?? null;
  const progress = action?.progress ?? false;
  const onClick = action?.onClick ?? null;

  useEffect(() => {
    handlerRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (text == null) return undefined;
    setAction({ text, progress, onClick: () => handlerRef.current?.() });
    return () => setAction(null);
  }, [progress, setAction, text]);
}
