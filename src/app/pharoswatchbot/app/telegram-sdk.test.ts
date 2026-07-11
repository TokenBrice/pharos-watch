// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { applyTelegramTheme, type TelegramWebAppSdk } from "./telegram-sdk";
import { telegramThemeContrastRatio } from "./telegram-theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

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
