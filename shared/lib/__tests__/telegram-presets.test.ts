import { describe, expect, it } from "vitest";
import {
  TELEGRAM_PRESET_DEFINITIONS,
  TELEGRAM_PRESET_IDS,
} from "../telegram-presets";

describe("Telegram preset definitions", () => {
  it("derive the unique preset-id roster in definition order", () => {
    expect(TELEGRAM_PRESET_IDS).toEqual([
      "usd-top10",
      "usd-top25",
      "usd-top50",
      "non-usd-top10",
      "non-usd-top25",
      "non-usd-top50",
      "eur-top10",
      "gold-top5",
      "mcap-ge-1b",
      "mcap-ge-100m",
    ]);
    expect(TELEGRAM_PRESET_IDS).toEqual(TELEGRAM_PRESET_DEFINITIONS.map(({ id }) => id));
    expect(new Set(TELEGRAM_PRESET_IDS).size).toBe(TELEGRAM_PRESET_IDS.length);
  });
});
