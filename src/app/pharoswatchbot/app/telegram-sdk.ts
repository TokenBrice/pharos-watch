"use client";

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  button_color?: string;
  button_text_color?: string;
}

type TelegramWebAppEvent = "themeChanged" | "viewportChanged";

interface TelegramSafeAreaInset {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface TelegramWebAppSdk {
  initData: string;
  initDataUnsafe?: {
    user?: { first_name?: string; username?: string };
    start_param?: string;
  };
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: TelegramSafeAreaInset;
  contentSafeAreaInset?: TelegramSafeAreaInset;
  themeParams?: TelegramThemeParams;
  ready?: () => void;
  expand?: () => void;
  onEvent?: (eventType: TelegramWebAppEvent, eventHandler: () => void) => void;
  offEvent?: (eventType: TelegramWebAppEvent, eventHandler: () => void) => void;
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
  const safeArea = webApp.contentSafeAreaInset ?? webApp.safeAreaInset;
  if (safeArea) {
    document.documentElement.style.setProperty("--telegram-safe-area-top", `${Math.max(0, safeArea.top ?? 0)}px`);
    document.documentElement.style.setProperty("--telegram-safe-area-right", `${Math.max(0, safeArea.right ?? 0)}px`);
    document.documentElement.style.setProperty("--telegram-safe-area-bottom", `${Math.max(0, safeArea.bottom ?? 0)}px`);
    document.documentElement.style.setProperty("--telegram-safe-area-left", `${Math.max(0, safeArea.left ?? 0)}px`);
  }
  const theme = webApp.themeParams;
  if (theme?.bg_color) document.documentElement.style.setProperty("--telegram-bg", theme.bg_color);
  if (theme?.text_color) document.documentElement.style.setProperty("--telegram-text", theme.text_color);
  if (theme?.button_color) document.documentElement.style.setProperty("--telegram-button", theme.button_color);
  if (theme?.button_text_color) document.documentElement.style.setProperty("--telegram-button-text", theme.button_text_color);
}

export function bindTelegramViewportAndTheme(webApp: TelegramWebAppSdk | null): () => void {
  if (!webApp?.onEvent || !webApp.offEvent) return () => {};
  const update = () => applyTelegramTheme(webApp);
  webApp.onEvent("themeChanged", update);
  webApp.onEvent("viewportChanged", update);
  return () => {
    webApp.offEvent?.("themeChanged", update);
    webApp.offEvent?.("viewportChanged", update);
  };
}
