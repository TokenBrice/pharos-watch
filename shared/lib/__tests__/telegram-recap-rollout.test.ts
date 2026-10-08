import { describe, expect, it } from "vitest";
import { isTelegramRecapAvailable, resolveTelegramRecapRolloutPolicy, shouldQueueTelegramRecap } from "../telegram-recap-rollout";

describe("Telegram recap availability", () => {
  it.each([undefined, "", "off", "dark", "canary", "unknown"])("fails unset/retired/malformed mode %s to off", (mode) => {
    const policy = resolveTelegramRecapRolloutPolicy({ TELEGRAM_RECAP_ROLLOUT_MODE: mode });
    expect(policy).toEqual({ mode: "off" });
    expect(isTelegramRecapAvailable(policy)).toBe(false);
    expect(shouldQueueTelegramRecap(policy)).toBe(false);
  });

  it("allows public controls and delivery without a recipient allowlist", () => {
    const policy = resolveTelegramRecapRolloutPolicy({ TELEGRAM_RECAP_ROLLOUT_MODE: " PUBLIC " });
    expect(policy).toEqual({ mode: "public" });
    expect(isTelegramRecapAvailable(policy)).toBe(true);
    expect(shouldQueueTelegramRecap(policy)).toBe(true);
  });
});
