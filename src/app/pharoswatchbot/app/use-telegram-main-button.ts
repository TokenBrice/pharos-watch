"use client";

import { useEffect, useRef } from "react";
import type { TelegramWebAppSdk } from "./telegram-sdk";

/**
 * Hook for managing the Telegram MainButton lifecycle.
 *
 * ## Cleanup contract
 *
 * Telegram's MainButton API (`onClick` / `offClick` / `show` / `hide` / `setParams`)
 * does not fit React's standard "attach handler in effect, detach in cleanup" idiom
 * cleanly because:
 *
 * 1. Handler identity matters: `offClick` requires the SAME function reference
 *    that was passed to `onClick`. A stale-closure handler captured at attach
 *    time is the one Telegram remembers — not the latest render's handler.
 * 2. Transitioning from "have a handler" to "no handler" must still detach the
 *    previously-attached listener. A naive cleanup that only fires when the
 *    effect re-runs with new deps would leak listeners across renders where the
 *    consumer flips from handler-present to handler-absent.
 *
 * To address (1) and (2) this hook tracks the currently-attached handler via a
 * ref (`attachedHandlerRef`). On every effect run we eagerly detach the prior
 * handler from the ref before attaching the new one. The cleanup function
 * additionally detaches the locally-captured handler and clears the ref slot
 * if it still points at the same handler.
 *
 * Future maintainers: the ref IS the contract. If you refactor this hook, do
 * not remove the ref-based detach — without it, a render that transitions to
 * `handler = null` will leave the prior listener attached on the Telegram side.
 */
export type UseTelegramMainButtonArgs = {
  webApp: TelegramWebAppSdk | null;
  text: string | null;
  handler: (() => void) | null;
  visible?: boolean;
  active?: boolean;
  color?: string;
  textColor?: string;
};

export function useTelegramMainButton(args: UseTelegramMainButtonArgs): void {
  const { webApp, text, handler, visible, active, color, textColor } = args;
  const attachedHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb) return;

    // Detach any previously attached handler before attaching a new one or hiding.
    if (attachedHandlerRef.current) {
      mb.offClick?.(attachedHandlerRef.current);
      attachedHandlerRef.current = null;
    }

    const resolvedVisible = visible ?? (text != null && handler != null);
    const resolvedActive = active ?? true;

    if (resolvedVisible && text) {
      const buttonColor = color ?? webApp?.themeParams?.button_color;
      mb.setParams?.({
        text,
        is_visible: true,
        is_active: resolvedActive,
        ...(buttonColor ? { color: buttonColor } : {}),
        ...(textColor ? { text_color: textColor } : {}),
      });
      if (resolvedActive && handler) {
        mb.onClick?.(handler);
        attachedHandlerRef.current = handler;
      }
      mb.show?.();
      const localHandler = resolvedActive && handler ? handler : null;
      return () => {
        if (localHandler) mb.offClick?.(localHandler);
        if (localHandler && attachedHandlerRef.current === localHandler) {
          attachedHandlerRef.current = null;
        }
        mb.hide?.();
      };
    }
    mb.hide?.();
    return undefined;
  }, [webApp, text, handler, visible, active, color, textColor]);
}
