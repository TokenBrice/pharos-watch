import { describe, expect, it } from "vitest";
import { normalizeTelegramTheme, telegramThemeContrastRatio } from "./telegram-theme";

function expectContrast(first: string, second: string, minimum: number): void {
  expect(telegramThemeContrastRatio(first, second)).toBeGreaterThanOrEqual(minimum);
}

function expectAccessibleTheme(theme: NonNullable<ReturnType<typeof normalizeTelegramTheme>>): void {
  const surfaces = [
    theme.background,
    theme.secondaryBackground,
    theme.sectionBackground,
    theme.controlBackground,
  ];
  for (const surface of surfaces) {
    expectContrast(theme.text, surface, 4.5);
    expectContrast(theme.hint, surface, 4.5);
    expectContrast(theme.subtitleText, surface, 4.5);
    expectContrast(theme.accentText, surface, 4.5);
    expectContrast(theme.link, surface, 4.5);
    expectContrast(theme.destructiveText, surface, 4.5);
    expectContrast(theme.button, surface, 3);
    expectContrast(theme.border, surface, 3);
    expectContrast(theme.focusRing, surface, 3);
  }
  expectContrast(theme.buttonText, theme.button, 4.5);
  expectContrast(theme.sectionHeaderText, theme.sectionBackground, 4.5);
}

describe("normalizeTelegramTheme", () => {
  it("preserves compliant Telegram colors", () => {
    const theme = normalizeTelegramTheme(
      {
        bg_color: "#ffffff",
        text_color: "#111827",
        secondary_bg_color: "#f3f4f6",
        section_bg_color: "#ffffff",
        hint_color: "#4b5563",
        subtitle_text_color: "#4b5563",
        button_color: "#1266a3",
        button_text_color: "#ffffff",
        link_color: "#1266a3",
        accent_text_color: "#1266a3",
        destructive_text_color: "#b42318",
      },
      "light",
    );

    expect(theme).toMatchObject({
      background: "#ffffff",
      text: "#111827",
      secondaryBackground: "#f3f4f6",
      sectionBackground: "#ffffff",
      hint: "#4b5563",
      subtitleText: "#4b5563",
      button: "#1266a3",
      buttonText: "#ffffff",
      link: "#1266a3",
      accentText: "#1266a3",
      destructiveText: "#b42318",
    });
    expectAccessibleTheme(theme!);
  });

  it("repairs hostile low-contrast light theme parameters", () => {
    const theme = normalizeTelegramTheme(
      {
        bg_color: "#ffffff",
        text_color: "#fefefe",
        secondary_bg_color: "#fdfdfd",
        section_bg_color: "#fcfcfc",
        hint_color: "#fafafa",
        subtitle_text_color: "#fbfbfb",
        button_color: "#fefefe",
        button_text_color: "#ffffff",
        link_color: "#f8f8f8",
        accent_text_color: "#f7f7f7",
        section_header_text_color: "#f6f6f6",
        destructive_text_color: "#f5f5f5",
      },
      "light",
    );

    expect(theme).not.toBeNull();
    expectAccessibleTheme(theme!);
    expect(theme?.button).not.toBe("#fefefe");
    expect(theme?.buttonText).not.toBe("#ffffff");
  });

  it("repairs hostile low-contrast dark theme parameters", () => {
    const theme = normalizeTelegramTheme(
      {
        bg_color: "#050505",
        text_color: "#080808",
        secondary_bg_color: "#090909",
        section_bg_color: "#0a0a0a",
        hint_color: "#101010",
        subtitle_text_color: "#111111",
        button_color: "#0b0b0b",
        button_text_color: "#000000",
        link_color: "#121212",
        accent_text_color: "#131313",
        destructive_text_color: "#141414",
      },
      "dark",
    );

    expect(theme).not.toBeNull();
    expectAccessibleTheme(theme!);
  });

  it("leaves the CSS fallback theme authoritative without a valid theme anchor", () => {
    expect(normalizeTelegramTheme(undefined, "dark")).toBeNull();
    expect(normalizeTelegramTheme({ button_color: "not-a-color" }, "light")).toBeNull();
  });

  it("calculates WCAG contrast ratios for validated hex colors", () => {
    expect(telegramThemeContrastRatio("#000000", "#ffffff")).toBe(21);
    expect(telegramThemeContrastRatio("invalid", "#ffffff")).toBeNull();
  });
});
