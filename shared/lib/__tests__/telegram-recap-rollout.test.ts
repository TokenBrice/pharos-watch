import { describe, expect, it } from "vitest";
import {
  isTelegramRecapAvailableToChat,
  resolveTelegramRecapRolloutPolicy,
  shouldPlanTelegramRecap,
  shouldQueueTelegramRecap,
} from "../telegram-recap-rollout";

describe("Telegram recap rollout policy", () => {
  it("defaults unset and malformed configuration to the safe off mode", () => {
    expect(resolveTelegramRecapRolloutPolicy({}).mode).toBe("off");
    expect(resolveTelegramRecapRolloutPolicy({ TELEGRAM_RECAP_ROLLOUT_MODE: "enabled" }).mode).toBe("off");
  });

  it("uses exact trimmed chat-id allowlist membership for canary controls and delivery", () => {
    const policy = resolveTelegramRecapRolloutPolicy({
      TELEGRAM_RECAP_ROLLOUT_MODE: "canary",
      TELEGRAM_RECAP_ROLLOUT_CHAT_IDS: " 42, 0042, -7 ",
    });

    expect(isTelegramRecapAvailableToChat(policy, "42")).toBe(true);
    expect(isTelegramRecapAvailableToChat(policy, "0042")).toBe(true);
    expect(isTelegramRecapAvailableToChat(policy, " 42")).toBe(false);
    expect(isTelegramRecapAvailableToChat(policy, "43")).toBe(false);
    expect(shouldPlanTelegramRecap(policy, "42")).toBe(true);
    expect(shouldPlanTelegramRecap(policy, "43")).toBe(false);
    expect(shouldQueueTelegramRecap(policy)).toBe(true);
  });

  it("keeps dark planning DB-only and allows no chat controls", () => {
    const policy = resolveTelegramRecapRolloutPolicy({ TELEGRAM_RECAP_ROLLOUT_MODE: "dark" });

    expect(shouldPlanTelegramRecap(policy, "42")).toBe(true);
    expect(shouldQueueTelegramRecap(policy)).toBe(false);
    expect(isTelegramRecapAvailableToChat(policy, "42")).toBe(false);
  });
});
