import type { CSSProperties } from "react";
import { CAUSE_HEX, CAUSE_HEX_DARK, type CauseOfDeath } from "@shared/lib/cause-of-death";

/**
 * Theme-correct cause colour without reading the theme in JS: set both hex
 * values as custom properties on an element, then pick them with the static
 * class constants below (`dark:` swaps to the dark-theme value).
 */
export function causeColorVars(cause: CauseOfDeath): CSSProperties {
  return {
    "--cause-hex": CAUSE_HEX[cause],
    "--cause-hex-dark": CAUSE_HEX_DARK[cause],
  } as CSSProperties;
}

export const CAUSE_BG_CLASS = "bg-[var(--cause-hex)] dark:bg-[var(--cause-hex-dark)]";
export const CAUSE_TEXT_FILL_CLASS = "fill-[var(--cause-hex)] dark:fill-[var(--cause-hex-dark)]";
export const CAUSE_STROKE_CLASS = "stroke-[var(--cause-hex)] dark:stroke-[var(--cause-hex-dark)]";
export const CAUSE_BORDER_CLASS = "border-[var(--cause-hex)] dark:border-[var(--cause-hex-dark)]";
