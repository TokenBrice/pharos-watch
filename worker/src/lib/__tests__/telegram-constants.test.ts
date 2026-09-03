import { describe, expect, it } from "vitest";
import {
  BLOCK_STRIKE_WINDOW_SEC,
  DEPEG_STEP_VALUES,
  DISAMBIGUATION_TTL_SEC,
  PENDING_BACKOFF_SCHEDULE_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  SNOOZE_SECONDS,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_MESSAGE_CHUNK_LIMIT,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_SPLIT_VERSION,
  TOP_VIEW_NAMES,
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

  it("maps snooze tokens to seconds", () => {
    expect(SNOOZE_SECONDS["1h"]).toBe(60 * 60);
    expect(SNOOZE_SECONDS["4h"]).toBe(4 * 60 * 60);
    expect(SNOOZE_SECONDS["24h"]).toBe(24 * 60 * 60);
  });

  it("lists the recognized /top views", () => {
    expect(TOP_VIEW_NAMES).toEqual([
      "depeg",
      "dews",
      "yield",
      "liquidity",
      "chains",
      "safety",
    ]);
  });

  it("keeps chunk limit below Telegram's 4096 cap with headroom", () => {
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBe(4000);
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBeLessThan(4096);
  });

  it("declares pending-queue tuning values", () => {
    expect(PENDING_TTL_SEC).toBe(2 * 60 * 60);
    expect(TELEGRAM_ALERT_TTL_SEC.depeg).toBe(PENDING_TTL_SEC);
    expect(TELEGRAM_ALERT_TTL_SEC.dews).toBe(PENDING_TTL_SEC);
    expect(TELEGRAM_ALERT_TTL_SEC.safety).toBe(PENDING_TTL_SEC);
    expect(TELEGRAM_ALERT_TTL_SEC.launch).toBe(90 * 60);
    expect(TELEGRAM_ALERT_TTL_SEC.adminBroadcast).toBe(45 * 60);
    expect(TELEGRAM_MAX_MESSAGES_PER_RUN).toBe(3600);
    expect(TELEGRAM_PENDING_DRAIN_BUDGET).toBe(1800);
    expect(SEND_BATCH_SIZE).toBe(4);
    expect(PENDING_MAX_ATTEMPTS).toBe(20);
    expect(PENDING_BACKOFF_SCHEDULE_SEC).toEqual([60, 120, 240, 480, 600]);
    expect(BLOCK_STRIKE_WINDOW_SEC).toBe(24 * 3600);
  });

  it("declares webhook disambiguation TTL", () => {
    expect(DISAMBIGUATION_TTL_SEC).toBe(5 * 60);
  });

  it("declares a stable split-version token", () => {
    expect(TELEGRAM_SPLIT_VERSION).toBe(1);
  });
});
