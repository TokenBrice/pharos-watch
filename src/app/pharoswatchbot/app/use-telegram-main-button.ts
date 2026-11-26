"use client";

import { useEffect } from "react";
import type { TelegramWebAppSdk } from "./telegram-sdk";
import { normalizeTelegramTheme } from "./telegram-theme";

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
  const resolvedVisible = Boolean((visible ?? (text != null && handler != null)) && text);
  const resolvedActive = active ?? true;

  // Update button label, activity and normalized palette in place without hide/show flicker.
  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb || !resolvedVisible || !text) return;

    const normalized = normalizeTelegramTheme(webApp.themeParams, webApp.colorScheme);
    const muted = !resolvedActive && !progress;
    const buttonColor = color
      ?? (muted
        ? normalized?.buttonMuted ?? webApp.themeParams?.hint_color ?? webApp.themeParams?.button_color
        : normalized?.button ?? webApp.themeParams?.button_color);
    const buttonTextColor = textColor
      ?? (muted ? normalized?.buttonMutedText ?? normalized?.buttonText : normalized?.buttonText);

    mb.setParams?.({
      text,
      is_visible: true,
      is_active: resolvedActive,
      ...(buttonColor ? { color: buttonColor } : {}),
      ...(buttonTextColor ? { text_color: buttonTextColor } : {}),
    });
  }, [webApp, resolvedVisible, text, resolvedActive, progress, color, textColor]);

  // Separate visibility/unmount lifecycle so label or state changes never flicker the bar.
  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb) return;
    if (!resolvedVisible) {
      mb.hide?.();
      return;
    }
    mb.show?.();
    return () => {
      mb.hide?.();
    };
  }, [webApp, resolvedVisible]);

  // Attach and detach the exact click handler identity.
  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb || !resolvedVisible || !resolvedActive || !handler) return;
    mb.onClick?.(handler);
    return () => {
      mb.offClick?.(handler);
    };
  }, [webApp, resolvedVisible, resolvedActive, handler]);

  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb || !progress) return undefined;
    mb.showProgress?.(false);
    return () => mb.hideProgress?.();
  }, [progress, webApp]);
}
