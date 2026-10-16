import { describe, expect, it } from "vitest";
import {
  DEPEG_STEP_VALUES,
  TELEGRAM_MESSAGE_CHUNK_LIMIT,
  isDepegStepValue,
} from "../telegram/constants";

describe("telegram-constants", () => {
  it("exposes the canonical depeg-step values and accepts only those", () => {
    expect(DEPEG_STEP_VALUES).toEqual([100, 250, 500]);
    expect(isDepegStepValue(100)).toBe(true);
    expect(isDepegStepValue(250)).toBe(true);
    expect(isDepegStepValue(500)).toBe(true);
    expect(isDepegStepValue(0)).toBe(false);
    expect(isDepegStepValue(99)).toBe(false);
    expect(isDepegStepValue(null)).toBe(false);
    expect(isDepegStepValue(undefined)).toBe(false);
    expect(isDepegStepValue("100")).toBe(false);
  });

  it("keeps chunk limit below Telegram's 4096 cap with headroom", () => {
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBe(4000);
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBeLessThan(4096);
  });

});
