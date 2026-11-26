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
  "--telegram-snackbar-bg",
  "--telegram-snackbar-action",
  "--telegram-snackbar-ring",
  "--telegram-switch-off-bg",
] as const;

export interface TelegramPopupButton {
  id?: string;
  type?: "default" | "ok" | "close" | "cancel" | "destructive";
  text?: string;
}

export interface TelegramPopupParams {
  title?: string;
  message: string;
  buttons?: TelegramPopupButton[];
}

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
  showProgress?: (leaveActive?: boolean) => void;
  hideProgress?: () => void;
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
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  isVersionAtLeast?: (version: string) => boolean;
  showConfirm?: (message: string, callback: (confirmed: boolean) => void) => void;
  showPopup?: (params: TelegramPopupParams, callback?: (buttonId: string) => void) => void;
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
  /** URL-decoded `tgWebAppData` from the launch link; the Worker still validates its signature. */
  launchInitData: string;
  startParam: string | null;
  previewName: string | null;
  hasTelegramLaunchHint: boolean;
} {
  if (typeof window === "undefined") {
    return { webApp: null, initData: "", launchInitData: "", startParam: null, previewName: null, hasTelegramLaunchHint: false };
  }
  const webApp = window.Telegram?.WebApp ?? null;
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
  const launchData = hash.get("tgWebAppData") ?? search.get("tgWebAppData");
  const launchPlatform = hash.get("tgWebAppPlatform") ?? search.get("tgWebAppPlatform") ?? webApp?.platform ?? null;
  const hasUnsupportedTelegramHost = launchPlatform?.toLowerCase() === "unknown";
  // Loading telegram-web-app.js creates WebApp with platform="unknown" in every browser.
  // A supported Telegram host justifies the long SDK poll even before `tgWebAppData`
  // arrives, so a launch that never yields a payload keeps its own missing state;
  // the Worker remains authoritative for validating the data's signature.
  const hasTelegramLaunchHint = Boolean(launchPlatform && !hasUnsupportedTelegramHost);
  const launchParams = launchData && !hasUnsupportedTelegramHost ? new URLSearchParams(launchData) : null;
  return {
    webApp,
    initData: hasUnsupportedTelegramHost ? "" : webApp?.initData ?? "",
    launchInitData: hasUnsupportedTelegramHost ? "" : launchData ?? "",
    startParam: webApp?.initDataUnsafe?.start_param
      ?? search.get("tgWebAppStartParam")
      ?? search.get("startapp")
      ?? launchParams?.get("start_param")
      ?? null,
    previewName: hasUnsupportedTelegramHost
      ? null
      : webApp?.initDataUnsafe?.user?.first_name ?? webApp?.initDataUnsafe?.user?.username ?? null,
    hasTelegramLaunchHint,
  };
}

/** True when Telegram's native `showPopup` API (Bot API 6.2+) is available. */
export function canUseTelegramPopup(webApp: TelegramWebAppSdk | null): boolean {
  return Boolean(
    webApp?.showPopup
    && (webApp.isVersionAtLeast ? webApp.isVersionAtLeast("6.2") : true),
  );
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
  const edgePx = (inset: TelegramSafeAreaInset | undefined, edge: "top" | "bottom" | "left" | "right") =>
    `${Math.max(0, inset?.[edge] ?? 0)}px`;
  // Keep hardware and Telegram-chrome safe areas separate so CSS can take
  // `max(env(safe-area-inset-*), hardware) + content` without double-counting on iOS.
  root.setProperty("--telegram-hardware-safe-area-top", edgePx(safe, "top"));
  root.setProperty("--telegram-hardware-safe-area-right", edgePx(safe, "right"));
  root.setProperty("--telegram-hardware-safe-area-bottom", edgePx(safe, "bottom"));
  root.setProperty("--telegram-hardware-safe-area-left", edgePx(safe, "left"));
  root.setProperty("--telegram-content-safe-area-top", edgePx(content, "top"));
  root.setProperty("--telegram-content-safe-area-right", edgePx(content, "right"));
  root.setProperty("--telegram-content-safe-area-bottom", edgePx(content, "bottom"));
  root.setProperty("--telegram-content-safe-area-left", edgePx(content, "left"));

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
        "--telegram-snackbar-bg": normalizedTheme.snackbarBackground,
        "--telegram-snackbar-action": normalizedTheme.snackbarAction,
        "--telegram-snackbar-ring": normalizedTheme.snackbarRing,
        "--telegram-switch-off-bg": normalizedTheme.switchOffBackground,
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
  // Sync native Telegram header, background, and bottom bar chrome (version-gated).
  if (normalizedTheme) {
    if (webApp.isVersionAtLeast?.("6.9")) {
      webApp.setHeaderColor?.(normalizedTheme.secondaryBackground);
    } else if (webApp.isVersionAtLeast?.("6.1")) {
      webApp.setHeaderColor?.("secondary_bg_color");
    }
    if (webApp.isVersionAtLeast?.("6.1")) {
      webApp.setBackgroundColor?.(normalizedTheme.secondaryBackground);
    }
    if (webApp.isVersionAtLeast?.("7.10")) {
      webApp.setBottomBarColor?.(
        webApp.themeParams?.bottom_bar_bg_color
          ? normalizedTheme.bottomBarBackground
          : normalizedTheme.secondaryBackground,
      );
    }
  }
  // Paint the document itself so overscroll and safe-area strips match the
  // Telegram page colour instead of flashing the site's light background.
  for (const element of [document.documentElement, document.body]) {
    if (!element) continue;
    if (normalizedTheme) element.style.backgroundColor = normalizedTheme.secondaryBackground;
    else element.style.removeProperty("background-color");
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
