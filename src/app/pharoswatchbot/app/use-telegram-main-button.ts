"use client";

import { useEffect } from "react";
import type { TelegramWebAppSdk } from "./telegram-sdk";

/** Attach each MainButton handler once and detach that same identity in cleanup. */
export type UseTelegramMainButtonArgs = {
  webApp: TelegramWebAppSdk | null;
  text: string | null;
  handler: (() => void) | null;
  visible?: boolean;
  active?: boolean;
  color?: string;
  textColor?: string;
  /** Native spinner while the action's request runs. */
  progress?: boolean;
};

export function useTelegramMainButton(args: UseTelegramMainButtonArgs): void {
  const { webApp, text, handler, visible, active, color, textColor, progress } = args;

  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb) return;

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
      }
      mb.show?.();
      const localHandler = resolvedActive && handler ? handler : null;
      return () => {
        if (localHandler) mb.offClick?.(localHandler);
        mb.hide?.();
      };
    }
    mb.hide?.();
    return undefined;
  }, [webApp, text, handler, visible, active, color, textColor]);

  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb || !progress) return undefined;
    mb.showProgress?.(false);
    return () => mb.hideProgress?.();
  }, [progress, webApp]);
}
