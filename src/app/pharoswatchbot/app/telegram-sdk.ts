"use client";

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  button_color?: string;
  button_text_color?: string;
  hint_color?: string;
  link_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
  bottom_bar_bg_color?: string;
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

  const theme = webApp.themeParams;
  const setThemeVar = (varName: string, value: string | undefined) => {
    if (value) root.setProperty(varName, value);
  };
  setThemeVar("--telegram-bg", theme?.bg_color);
  setThemeVar("--telegram-text", theme?.text_color);
  setThemeVar("--telegram-button", theme?.button_color);
  setThemeVar("--telegram-button-text", theme?.button_text_color);
  setThemeVar("--telegram-hint", theme?.hint_color);
  setThemeVar("--telegram-link", theme?.link_color);
  setThemeVar("--telegram-secondary-bg", theme?.secondary_bg_color);
  setThemeVar("--telegram-header-bg", theme?.header_bg_color);
  setThemeVar("--telegram-accent-text", theme?.accent_text_color);
  setThemeVar("--telegram-section-bg", theme?.section_bg_color);
  setThemeVar("--telegram-section-header-text", theme?.section_header_text_color);
  setThemeVar("--telegram-subtitle-text", theme?.subtitle_text_color);
  setThemeVar("--telegram-destructive-text", theme?.destructive_text_color);
  if (webApp.colorScheme === "dark" || webApp.colorScheme === "light") {
    root.setProperty("--telegram-color-scheme", webApp.colorScheme);
  }
  if (webApp.isVersionAtLeast?.("8.0")) {
    setThemeVar("--telegram-bottom-bar-bg", theme?.bottom_bar_bg_color);
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
