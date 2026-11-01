// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { applyTelegramTheme, getTelegramLaunchContext, type TelegramWebAppSdk } from "./telegram-sdk";
import { telegramThemeContrastRatio } from "./telegram-theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  window.history.replaceState({}, "", "/");
});

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

describe("getTelegramLaunchContext", () => {
  it("exposes the URL-decoded signed launch payload without an SDK", () => {
    const signed = "auth_date=1800000000&hash=abc&user=%7B%7D";
    window.history.replaceState({}, "", `/pharoswatchbot/app/#tgWebAppData=${encodeURIComponent(signed)}&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop`);

    const launch = getTelegramLaunchContext();
    expect(launch.hasTelegramLaunchHint).toBe(true);
    expect(launch.webApp).toBeNull();
    expect(launch.launchInitData).toBe(signed);
  });

  it("keeps an unsupported host in preview without trusting URL launch data", () => {
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown");

    const launch = getTelegramLaunchContext();
    expect(launch.hasTelegramLaunchHint).toBe(false);
    expect(launch.launchInitData).toBe("");
  });
});

describe("applyTelegramTheme", () => {
  it("publishes accessible semantic variables while preserving viewport and safe-area behavior", () => {
    const webApp: TelegramWebAppSdk = {
      initData: "signed",
      colorScheme: "light",
      viewportStableHeight: 640,
      safeAreaInset: { top: 10, right: 2, bottom: 8, left: 3 },
      contentSafeAreaInset: { top: 4, right: 5, bottom: 6, left: 7 },
      isVersionAtLeast: () => true,
      themeParams: {
        bg_color: "#ffffff",
        text_color: "#fefefe",
        secondary_bg_color: "#fdfdfd",
        section_bg_color: "#fcfcfc",
        hint_color: "#fafafa",
        subtitle_text_color: "#fbfbfb",
        button_color: "#fefefe",
        button_text_color: "#ffffff",
      },
    };

    applyTelegramTheme(webApp);

    expect(cssVar("--telegram-viewport-height")).toBe("640px");
    expect(cssVar("--telegram-safe-area-top")).toBe("14px");
    expect(cssVar("--telegram-safe-area-right")).toBe("7px");
    expect(cssVar("--telegram-safe-area-bottom")).toBe("14px");
    expect(cssVar("--telegram-safe-area-left")).toBe("10px");
    expect(cssVar("--telegram-color-scheme")).toBe("light");
    expect(telegramThemeContrastRatio(cssVar("--telegram-text"), cssVar("--telegram-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(telegramThemeContrastRatio(cssVar("--telegram-subtitle-text"), cssVar("--telegram-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(telegramThemeContrastRatio(cssVar("--telegram-button"), cssVar("--telegram-bg"))).toBeGreaterThanOrEqual(3);
    expect(telegramThemeContrastRatio(cssVar("--telegram-button-text"), cssVar("--telegram-button"))).toBeGreaterThanOrEqual(4.5);
    expect(cssVar("--telegram-button")).not.toBe("#fefefe");
    expect(cssVar("--telegram-bottom-bar-bg")).not.toBe("");
  });

  it("removes stale inline theme values when Telegram supplies no valid palette", () => {
    applyTelegramTheme({
      initData: "signed",
      colorScheme: "light",
      themeParams: { bg_color: "#ffffff", text_color: "#111827" },
    });
    expect(cssVar("--telegram-bg")).toBe("#ffffff");

    applyTelegramTheme({ initData: "signed", colorScheme: "dark", themeParams: {} });

    expect(cssVar("--telegram-bg")).toBe("");
    expect(cssVar("--telegram-text")).toBe("");
    expect(cssVar("--telegram-color-scheme")).toBe("dark");
  });
});
