import { z } from "zod";

/**
 * The canonical ratio scale, where `1` represents 100%.
 *
 * Wire schemas must use `RatioSchema` rather than a bare `z.number()` for any field carrying a
 * relative change or share. The brand is type-only: `.brand()` is an identity at runtime and
 * `z.toJSONSchema` still emits `{"type":"number"}`, so the published contract is unaffected while
 * TypeScript refuses to pass a ratio where a 0-100 percentage is expected.
 *
 * This exists because that mistake shipped: chain OG images rendered `change7dPct` — a ratio — with
 * a `%` suffix, printing a +8.4% week as `0.1%`. Every other consumer multiplied by 100, so nothing
 * flagged it. Branding the field makes that class of error a compile error.
 *
 * Ratios may exceed the 0-1 range; a doubling is `1`, not a clamp.
 */
export const RatioSchema = z.number().brand<"ratio">();

export type Ratio = z.infer<typeof RatioSchema>;

/** The zero point on the ratio scale: no change. */
export const ZERO_RATIO = 0 as Ratio;
