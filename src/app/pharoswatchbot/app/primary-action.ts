"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { MiniAppPrimaryAction } from "./types";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type SetPrimaryAction = (action: MiniAppPrimaryAction | null) => void;

export const PrimaryActionContext = createContext<SetPrimaryAction>(() => {});

/**
 * Register the visible screen's single primary action. The shell renders it as
 * the Telegram MainButton; the click handler stays stable across renders so the
 * MainButton is not detached and re-attached on every keystroke. Uses a layout
 * effect so screen transitions and draft reconciliations update `screenAction`
 * before the shell's passive `useTelegramMainButton` effect runs.
 */
export function usePrimaryAction(action: MiniAppPrimaryAction | null): void {
  const setAction = useContext(PrimaryActionContext);
  const handlerRef = useRef<(() => void) | null>(null);
  const kind = action?.kind ?? null;
  const text = action?.text ?? null;
  const progress = action?.progress ?? false;
  const onClick = action?.onClick ?? null;

  useIsomorphicLayoutEffect(() => {
    handlerRef.current = onClick;
  }, [onClick]);

  useIsomorphicLayoutEffect(() => {
    if (kind == null || text == null) return undefined;
    setAction({ kind, text, progress, onClick: () => handlerRef.current?.() });
    return () => setAction(null);
  }, [kind, progress, setAction, text]);
}
