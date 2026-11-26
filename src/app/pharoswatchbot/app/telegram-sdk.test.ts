// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTelegramTheme, canUseTelegramPopup, getTelegramLaunchContext, type TelegramWebAppSdk } from "./telegram-sdk";
import { telegramThemeContrastRatio } from "./telegram-theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  window.history.replaceState({}, "", "/");
});

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

describe("getTelegramLaunchContext", () => {
  it("exposes the URL-decoded signed launch payload and start_param without an SDK", () => {
    const signed = "auth_date=1800000000&start_param=coin_usdc-circle&hash=abc&user=%7B%7D";
    window.history.replaceState({}, "", `/pharoswatchbot/app/#tgWebAppData=${encodeURIComponent(signed)}&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop`);

    const launch = getTelegramLaunchContext();
    expect(launch.hasTelegramLaunchHint).toBe(true);
    expect(launch.webApp).toBeNull();
    expect(launch.launchInitData).toBe(signed);
    expect(launch.startParam).toBe("coin_usdc-circle");
  });

  it("keeps the missing-launch state reachable on a supported host without a payload", () => {
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");

    const launch = getTelegramLaunchContext();
    expect(launch.hasTelegramLaunchHint).toBe(true);
    expect(launch.initData).toBe("");
    expect(launch.launchInitData).toBe("");
  });

  it("keeps an unsupported host in preview without trusting URL launch data", () => {
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown");

    const launch = getTelegramLaunchContext();
    expect(launch.hasTelegramLaunchHint).toBe(false);
    expect(launch.launchInitData).toBe("");
  });
});

describe("applyTelegramTheme", () => {
  it("publishes accessible semantic variables, separate safe areas, and native chrome colors", () => {
    const setHeaderColor = vi.fn();
    const setBackgroundColor = vi.fn();
    const setBottomBarColor = vi.fn();
    const webApp: TelegramWebAppSdk = {
      initData: "signed",
      colorScheme: "light",
      viewportStableHeight: 640,
      safeAreaInset: { top: 10, right: 2, bottom: 8, left: 3 },
      contentSafeAreaInset: { top: 4, right: 5, bottom: 6, left: 7 },
      isVersionAtLeast: () => true,
      setHeaderColor,
      setBackgroundColor,
      setBottomBarColor,
      showPopup: vi.fn(),
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
    for (const [edge, hw, content] of [["top", "10px", "4px"], ["right", "2px", "5px"], ["bottom", "8px", "6px"], ["left", "3px", "7px"]] as const) {
      expect(cssVar(`--telegram-hardware-safe-area-${edge}`)).toBe(hw);
      expect(cssVar(`--telegram-content-safe-area-${edge}`)).toBe(content);
    }
    expect(cssVar("--telegram-color-scheme")).toBe("light");
    for (const [fg, bg, min] of [
      ["--telegram-text", "--telegram-bg", 4.5],
      ["--telegram-subtitle-text", "--telegram-bg", 4.5],
      ["--telegram-button", "--telegram-bg", 3],
      ["--telegram-button-text", "--telegram-button", 4.5],
      ["--telegram-snackbar-action", "--telegram-snackbar-bg", 4.5],
      ["--telegram-snackbar-ring", "--telegram-snackbar-bg", 3],
      ["--telegram-switch-off-bg", "--telegram-section-bg", 3],
    ] as const) {
      expect(telegramThemeContrastRatio(cssVar(fg), cssVar(bg))).toBeGreaterThanOrEqual(min);
    }
    expect(cssVar("--telegram-button")).not.toBe("#fefefe");
    expect(cssVar("--telegram-bottom-bar-bg")).not.toBe("");
    const secBg = cssVar("--telegram-secondary-bg");
    expect([setHeaderColor.mock.calls[0]?.[0], setBackgroundColor.mock.calls[0]?.[0], setBottomBarColor.mock.calls[0]?.[0]]).toEqual([secBg, secBg, secBg]);
    expect([canUseTelegramPopup(webApp), canUseTelegramPopup({ ...webApp, isVersionAtLeast: () => false })]).toEqual([true, false]);
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
