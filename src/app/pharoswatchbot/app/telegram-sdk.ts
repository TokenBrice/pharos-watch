"use client";

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  button_color?: string;
  button_text_color?: string;
}

export interface TelegramWebAppSdk {
  initData: string;
  initDataUnsafe?: {
    user?: { first_name?: string; username?: string };
    start_param?: string;
  };
  viewportHeight?: number;
  viewportStableHeight?: number;
  themeParams?: TelegramThemeParams;
  ready?: () => void;
  expand?: () => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  HapticFeedback?: { impactOccurred?: (style: "light" | "medium" | "heavy") => void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebAppSdk };
  }
}

export function getTelegramLaunchContext(): {
  webApp: TelegramWebAppSdk | null;
  initData: string;
  startParam: string | null;
  previewName: string | null;
} {
  if (typeof window === "undefined") return { webApp: null, initData: "", startParam: null, previewName: null };
  const webApp = window.Telegram?.WebApp ?? null;
  const search = new URLSearchParams(window.location.search);
  return {
    webApp,
    initData: webApp?.initData ?? "",
    startParam: webApp?.initDataUnsafe?.start_param ?? search.get("tgWebAppStartParam") ?? search.get("startapp"),
    previewName: webApp?.initDataUnsafe?.user?.first_name ?? webApp?.initDataUnsafe?.user?.username ?? null,
  };
}

export function applyTelegramTheme(webApp: TelegramWebAppSdk | null): void {
  if (typeof document === "undefined" || !webApp) return;
  const height = webApp.viewportStableHeight ?? webApp.viewportHeight;
  if (typeof height === "number" && Number.isFinite(height) && height > 0) {
    document.documentElement.style.setProperty("--telegram-viewport-height", `${height}px`);
  }
  const theme = webApp.themeParams;
  if (theme?.bg_color) document.documentElement.style.setProperty("--telegram-bg", theme.bg_color);
  if (theme?.text_color) document.documentElement.style.setProperty("--telegram-text", theme.text_color);
  if (theme?.button_color) document.documentElement.style.setProperty("--telegram-button", theme.button_color);
  if (theme?.button_text_color) document.documentElement.style.setProperty("--telegram-button-text", theme.button_text_color);
}
