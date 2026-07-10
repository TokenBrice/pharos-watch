export interface TelegramThemeParams {
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

export interface NormalizedTelegramTheme {
  background: string;
  text: string;
  button: string;
  buttonText: string;
  hint: string;
  link: string;
  secondaryBackground: string;
  headerBackground: string;
  accentText: string;
  sectionBackground: string;
  controlBackground: string;
  sectionHeaderText: string;
  subtitleText: string;
  destructiveText: string;
  bottomBarBackground: string;
  border: string;
  focusRing: string;
}

type Rgb = readonly [red: number, green: number, blue: number];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const TEXT_CONTRAST = 4.5;
const CONTROL_CONTRAST = 3;
// Channel rounding can shave a few hundredths off a computed ratio. Altered
// colors target a small buffer while already-compliant host colors stay exact.
const ADJUSTMENT_MARGIN = 0.1;

const FALLBACK = {
  light: {
    background: "#ffffff",
    text: "#111827",
    panel: "#f3f4f6",
    button: "#2481cc",
    buttonText: "#ffffff",
    muted: "#4b5563",
    link: "#1266a3",
    destructive: "#b42318",
  },
  dark: {
    background: "#111827",
    text: "#f9fafb",
    panel: "#1f2937",
    button: "#5aa9e6",
    buttonText: "#111827",
    muted: "#d1d5db",
    link: "#75bdf2",
    destructive: "#ff8a80",
  },
} as const;

function parseHexColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const match = /^#([\da-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function toHex([red, green, blue]: Rgb): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function mix(start: Rgb, end: Rgb, amount: number): Rgb {
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
    start[2] + (end[2] - start[2]) * amount,
  ];
}

function relativeLuminance([red, green, blue]: Rgb): number {
  const linearize = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function rgbContrastRatio(first: Rgb, second: Rgb): number {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

export function telegramThemeContrastRatio(first: string, second: string): number | null {
  const firstRgb = parseHexColor(first);
  const secondRgb = parseHexColor(second);
  return firstRgb && secondRgb ? rgbContrastRatio(firstRgb, secondRgb) : null;
}

function passesAgainst(color: Rgb, backgrounds: readonly Rgb[], minimum: number): boolean {
  return backgrounds.every((background) => rgbContrastRatio(color, background) >= minimum);
}

function minimalPassingMix(
  color: Rgb,
  target: Rgb,
  backgrounds: readonly Rgb[],
  minimum: number,
): { color: Rgb; amount: number } | null {
  const adjustedMinimum = minimum + ADJUSTMENT_MARGIN;
  if (!passesAgainst(target, backgrounds, adjustedMinimum)) return null;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 24; index += 1) {
    const middle = (low + high) / 2;
    if (passesAgainst(mix(color, target, middle), backgrounds, adjustedMinimum)) high = middle;
    else low = middle;
  }
  return { color: mix(color, target, high), amount: high };
}

function ensureContrastAcross(
  preferred: Rgb,
  backgrounds: readonly Rgb[],
  minimum: number,
  fallback: Rgb,
): Rgb {
  if (passesAgainst(preferred, backgrounds, minimum)) return preferred;
  const candidates = [
    minimalPassingMix(preferred, BLACK, backgrounds, minimum),
    minimalPassingMix(preferred, WHITE, backgrounds, minimum),
  ].filter((candidate): candidate is { color: Rgb; amount: number } => candidate !== null);
  candidates.sort((left, right) => left.amount - right.amount);
  return candidates[0]?.color ?? fallback;
}

function ensureSurfaceContrast(surface: Rgb, text: Rgb, background: Rgb): Rgb {
  if (rgbContrastRatio(text, surface) >= TEXT_CONTRAST) return surface;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 24; index += 1) {
    const middle = (low + high) / 2;
    if (rgbContrastRatio(text, mix(surface, background, middle)) >= TEXT_CONTRAST + ADJUSTMENT_MARGIN) high = middle;
    else low = middle;
  }
  return mix(surface, background, high);
}

function parsed(value: string | undefined, fallback: string): Rgb {
  return parseHexColor(value) ?? parseHexColor(fallback)!;
}

export function normalizeTelegramTheme(
  theme: TelegramThemeParams | undefined,
  colorScheme: "light" | "dark" | undefined,
): NormalizedTelegramTheme | null {
  const hasThemeAnchor = Boolean(
    parseHexColor(theme?.bg_color)
    ?? parseHexColor(theme?.text_color)
    ?? parseHexColor(theme?.secondary_bg_color)
    ?? parseHexColor(theme?.section_bg_color),
  );
  if (!hasThemeAnchor) return null;

  const fallback = FALLBACK[colorScheme === "dark" ? "dark" : "light"];
  const background = parsed(theme?.bg_color, fallback.background);
  const fallbackText = parsed(fallback.text, fallback.text);
  const text = ensureContrastAcross(
    parsed(theme?.text_color, fallback.text),
    [background],
    TEXT_CONTRAST,
    fallbackText,
  );
  const secondaryBackground = ensureSurfaceContrast(
    parsed(theme?.secondary_bg_color, fallback.panel),
    text,
    background,
  );
  const sectionBackground = ensureSurfaceContrast(
    parsed(theme?.section_bg_color, toHex(secondaryBackground)),
    text,
    background,
  );
  const controlBackground = ensureSurfaceContrast(mix(sectionBackground, text, 0.08), text, background);
  const surfaces = [background, secondaryBackground, sectionBackground, controlBackground] as const;
  const hint = ensureContrastAcross(parsed(theme?.hint_color, fallback.muted), surfaces, TEXT_CONTRAST, text);
  const subtitleText = ensureContrastAcross(
    parsed(theme?.subtitle_text_color, toHex(hint)),
    surfaces,
    TEXT_CONTRAST,
    text,
  );
  const button = ensureContrastAcross(
    parsed(theme?.button_color, fallback.button),
    surfaces,
    CONTROL_CONTRAST,
    text,
  );
  const buttonText = ensureContrastAcross(
    parsed(theme?.button_text_color, fallback.buttonText),
    [button],
    TEXT_CONTRAST,
    text,
  );
  const accentText = ensureContrastAcross(
    parsed(theme?.accent_text_color ?? theme?.link_color, fallback.link),
    surfaces,
    TEXT_CONTRAST,
    text,
  );
  const link = ensureContrastAcross(
    parsed(theme?.link_color, toHex(accentText)),
    surfaces,
    TEXT_CONTRAST,
    accentText,
  );
  const headerBackground = ensureSurfaceContrast(
    parsed(theme?.header_bg_color, toHex(background)),
    text,
    background,
  );
  const bottomBarBackground = ensureSurfaceContrast(
    parsed(theme?.bottom_bar_bg_color, toHex(background)),
    text,
    background,
  );
  const sectionHeaderText = ensureContrastAcross(
    parsed(theme?.section_header_text_color, toHex(accentText)),
    [sectionBackground],
    TEXT_CONTRAST,
    text,
  );
  const destructiveText = ensureContrastAcross(
    parsed(theme?.destructive_text_color, fallback.destructive),
    surfaces,
    TEXT_CONTRAST,
    text,
  );
  const border = ensureContrastAcross(hint, surfaces, CONTROL_CONTRAST, text);
  const focusRing = ensureContrastAcross(button, surfaces, CONTROL_CONTRAST, text);

  return {
    background: toHex(background),
    text: toHex(text),
    button: toHex(button),
    buttonText: toHex(buttonText),
    hint: toHex(hint),
    link: toHex(link),
    secondaryBackground: toHex(secondaryBackground),
    headerBackground: toHex(headerBackground),
    accentText: toHex(accentText),
    sectionBackground: toHex(sectionBackground),
    controlBackground: toHex(controlBackground),
    sectionHeaderText: toHex(sectionHeaderText),
    subtitleText: toHex(subtitleText),
    destructiveText: toHex(destructiveText),
    bottomBarBackground: toHex(bottomBarBackground),
    border: toHex(border),
    focusRing: toHex(focusRing),
  };
}
