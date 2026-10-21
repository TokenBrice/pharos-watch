import { describe, expect, it } from "vitest";
import {
  TELEGRAM_ALERT_EXAMPLES,
  TELEGRAM_COMMAND_GROUPS,
} from "./telegram-content";
import {
  PHAROSWATCHBOT_BOT_URL,
  RECOMMENDED_SETUP_COMMAND,
  RECOMMENDED_SETUP_DEEP_LINK,
} from "@/lib/telegram-route-constants";
import {
  TELEGRAM_MINI_APP_PAYLOAD_PATTERN,
  TELEGRAM_START_PAYLOAD_MAX_LENGTH,
} from "@shared/lib/telegram-mini-app-payloads";
import { TELEGRAM_COMMAND_NAMES } from "@shared/lib/telegram-bot-registration";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import { parseTelegramLandingToken, telegramLandingEntryForPlacement } from "@shared/lib/telegram-landing-links";

describe("PharosWatchBotPage", () => {
  it("keeps the public alert and command contracts complete", () => {
    expect(TELEGRAM_ALERT_EXAMPLES.map((alert) => alert.key)).toEqual([
      "dews",
      "depeg",
      "safety",
      "reserve",
      "freeze",
    ]);
    // Example bubbles must be the canonical formatter-verified samples.
    for (const example of TELEGRAM_ALERT_EXAMPLES) {
      expect(example.content).toBe(TELEGRAM_PUBLIC_ALERT_SAMPLES[example.key].message);
    }

    const publicCommands = new Set(
      TELEGRAM_COMMAND_GROUPS.flatMap((group) =>
        group.commands.map((entry) => entry.command.match(/^\/([a-z]+)/)?.[1]).filter(Boolean),
      ),
    );
    expect([...publicCommands].sort()).toEqual([...TELEGRAM_COMMAND_NAMES].sort());
    for (const retiredCommand of ["import", "export", "recap", "set", "mute", "timezone", "top", "brief"]) {
      expect(publicCommands.has(retiredCommand)).toBe(false);
    }
  });

  it("builds the recommended setup deep link from a registry-valid start payload", () => {
    const url = new URL(RECOMMENDED_SETUP_DEEP_LINK);
    const startPayload = url.searchParams.get("start");

    expect(`${url.origin}${url.pathname}`).toBe(PHAROSWATCHBOT_BOT_URL);
    const setupEntry = telegramLandingEntryForPlacement("setup");
    expect(startPayload).toBe(setupEntry.token);
    expect(parseTelegramLandingToken(startPayload)).toBe(setupEntry);
    expect(RECOMMENDED_SETUP_COMMAND).toBe("/subscribe dews,depeg usd-top25");
    expect(startPayload?.length).toBeLessThanOrEqual(TELEGRAM_START_PAYLOAD_MAX_LENGTH);
    expect(TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(startPayload ?? "")).toBe(true);
  });
});
