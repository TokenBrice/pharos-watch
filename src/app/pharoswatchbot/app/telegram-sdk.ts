"use client";

import { normalizeTelegramTheme, type TelegramThemeParams } from "./telegram-theme";

export type { TelegramThemeParams } from "./telegram-theme";

const TELEGRAM_THEME_VARIABLES = [
  "--telegram-bg",
  "--telegram-text",
  "--telegram-button",
  "--telegram-button-text",
  "--telegram-hint",
  "--telegram-link",
  "--telegram-secondary-bg",
  "--telegram-header-bg",
  "--telegram-accent-text",
  "--telegram-section-bg",
  "--telegram-section-header-text",
  "--telegram-subtitle-text",
  "--telegram-destructive-text",
  "--telegram-bottom-bar-bg",
  "--telegram-control-bg",
  "--telegram-border",
  "--telegram-ring",
] as const;

type TelegramWebAppEvent = "themeChanged" | "viewportChanged" | "safeAreaChanged" | "contentSafeAreaChanged";

interface TelegramSafeAreaInset {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

interface TelegramButton {
  show?: () => void;
  hide?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
  setText?: (text: string) => void;
  setParams?: (params: { text?: string; color?: string; text_color?: string; is_visible?: boolean; is_active?: boolean }) => void;
  text?: string;
  color?: string;
  isVisible?: boolean;
  isActive?: boolean;
}

interface TelegramBackButton {
  show?: () => void;
  hide?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
  isVisible?: boolean;
}

interface TelegramSettingsButton {
  show?: () => void;
  hide?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
  isVisible?: boolean;
}

export interface TelegramWebAppSdk {
  initData: string;
  platform?: string;
  initDataUnsafe?: {
    user?: { first_name?: string; username?: string };
    start_param?: string;
  };
  colorScheme?: "light" | "dark";
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
  isVersionAtLeast?: (version: string) => boolean;
  showConfirm?: (message: string, callback: (confirmed: boolean) => void) => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink?: (url: string) => void;
  requestWriteAccess?: (callback?: (allowed: boolean) => void) => void;
  addToHomeScreen?: () => void;
  checkHomeScreenStatus?: (callback: (status: string) => void) => void;
  close?: () => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (type: "success" | "error" | "warning") => void;
    selectionChanged?: () => void;
  };
  MainButton?: TelegramButton;
  BackButton?: TelegramBackButton;
  SettingsButton?: TelegramSettingsButton;
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
  hasTelegramLaunchHint: boolean;
} {
  if (typeof window === "undefined") {
    return { webApp: null, initData: "", startParam: null, previewName: null, hasTelegramLaunchHint: false };
  }
  const webApp = window.Telegram?.WebApp ?? null;
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
  const launchData = hash.get("tgWebAppData") ?? search.get("tgWebAppData");
  const launchPlatform = hash.get("tgWebAppPlatform") ?? search.get("tgWebAppPlatform") ?? webApp?.platform ?? null;
  const hasUnsupportedTelegramHost = launchPlatform?.toLowerCase() === "unknown";
  // Loading telegram-web-app.js creates WebApp with platform="unknown" in every browser.
  // Only Telegram-provided launch data on a supported host justifies the long SDK poll;
  // the Worker remains authoritative for validating the data's signature.
  const hasTelegramLaunchHint = Boolean(
    launchData
    && launchPlatform
    && !hasUnsupportedTelegramHost,
  );
  return {
    webApp,
    initData: hasUnsupportedTelegramHost ? "" : webApp?.initData ?? "",
    startParam: webApp?.initDataUnsafe?.start_param ?? search.get("tgWebAppStartParam") ?? search.get("startapp"),
    previewName: hasUnsupportedTelegramHost
      ? null
      : webApp?.initDataUnsafe?.user?.first_name ?? webApp?.initDataUnsafe?.user?.username ?? null,
    hasTelegramLaunchHint,
  };
}

// The Mini App shell scopes Pharos bridge tokens (`bg-card`, `border-border`,
// `text-foreground`) to the live Telegram palette. Export the full Bot API
// 6.9+ theme set as CSS variables so surface components can keep normal Pharos
// utility classes while still matching Telegram light/dark chrome.
export function applyTelegramTheme(webApp: TelegramWebAppSdk | null): void {
  if (typeof document === "undefined" || !webApp) return;
  const height = webApp.viewportStableHeight ?? webApp.viewportHeight;
  if (typeof height === "number" && Number.isFinite(height) && height > 0) {
    document.documentElement.style.setProperty("--telegram-viewport-height", `${height}px`);
  }
  const root = document.documentElement.style;
  const safe = webApp.safeAreaInset;
  const content = webApp.contentSafeAreaInset;
  const sumEdge = (edge: "top" | "bottom" | "left" | "right") =>
    Math.max(0, safe?.[edge] ?? 0) + Math.max(0, content?.[edge] ?? 0);
  root.setProperty("--telegram-safe-area-top", `${sumEdge("top")}px`);
  root.setProperty("--telegram-safe-area-right", `${sumEdge("right")}px`);
  root.setProperty("--telegram-safe-area-bottom", `${sumEdge("bottom")}px`);
  root.setProperty("--telegram-safe-area-left", `${sumEdge("left")}px`);

  const normalizedTheme = normalizeTelegramTheme(webApp.themeParams, webApp.colorScheme);
  const themeVars: Record<string, string | undefined> = normalizedTheme
    ? {
        "--telegram-bg": normalizedTheme.background,
        "--telegram-text": normalizedTheme.text,
        "--telegram-button": normalizedTheme.button,
        "--telegram-button-text": normalizedTheme.buttonText,
        "--telegram-hint": normalizedTheme.hint,
        "--telegram-link": normalizedTheme.link,
        "--telegram-secondary-bg": normalizedTheme.secondaryBackground,
        "--telegram-header-bg": normalizedTheme.headerBackground,
        "--telegram-accent-text": normalizedTheme.accentText,
        "--telegram-section-bg": normalizedTheme.sectionBackground,
        "--telegram-control-bg": normalizedTheme.controlBackground,
        "--telegram-section-header-text": normalizedTheme.sectionHeaderText,
        "--telegram-subtitle-text": normalizedTheme.subtitleText,
        "--telegram-destructive-text": normalizedTheme.destructiveText,
        "--telegram-bottom-bar-bg": webApp.isVersionAtLeast?.("8.0")
          ? normalizedTheme.bottomBarBackground
          : undefined,
        "--telegram-border": normalizedTheme.border,
        "--telegram-ring": normalizedTheme.focusRing,
      }
    : {};
  for (const varName of TELEGRAM_THEME_VARIABLES) {
    const value = themeVars[varName];
    if (value) root.setProperty(varName, value);
    else root.removeProperty(varName);
  }
  if (webApp.colorScheme === "dark" || webApp.colorScheme === "light") {
    root.setProperty("--telegram-color-scheme", webApp.colorScheme);
  }
}

export function bindTelegramViewportAndTheme(webApp: TelegramWebAppSdk | null): () => void {
  if (!webApp?.onEvent || !webApp.offEvent) return () => {};
  const update = () => applyTelegramTheme(webApp);
  webApp.onEvent("themeChanged", update);
  webApp.onEvent("viewportChanged", update);
  webApp.onEvent("safeAreaChanged", update);
  webApp.onEvent("contentSafeAreaChanged", update);
  return () => {
    webApp.offEvent?.("themeChanged", update);
    webApp.offEvent?.("viewportChanged", update);
    webApp.offEvent?.("safeAreaChanged", update);
    webApp.offEvent?.("contentSafeAreaChanged", update);
  };
}
