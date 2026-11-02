import { describe, expect, it } from "vitest";
import * as policy from "../telegram-delivery-policy";

describe("telegram delivery policy exports", () => {
  it("no longer exports the retired target-plan policy", () => {
    // Delivery v2 fan-out/drain inputs are the only live authority; these
    // retired target-plan budgets must not be importable again.
    for (const name of [
      "TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE",
      "TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE",
      "TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN",
      "TELEGRAM_PRESET_RESOLUTION_PAGE_SIZE",
      "TELEGRAM_PRESET_RESOLUTION_MAX_PAGES_PER_RUN",
      "TELEGRAM_PRESET_RESOLUTION_MAX_MS_PER_RUN",
      "estimateTelegramTargetPlanCoordinatorBound",
    ]) {
      expect(policy).not.toHaveProperty(name);
    }
    expect(policy.TELEGRAM_FANOUT_PAGE_CHATS).toBeGreaterThan(0);
  });

  it("keeps the message chunk limit below Telegram's 4096-byte cap with headroom", () => {
    expect(policy.TELEGRAM_MESSAGE_CHUNK_LIMIT).toBeLessThan(4096);
  });
});
