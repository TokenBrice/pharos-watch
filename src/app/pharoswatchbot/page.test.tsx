import { describe, expect, it } from "vitest";
import {
  MINI_APP_FEATURES,
  TELEGRAM_ACTIONS,
  TELEGRAM_ALERT_EXAMPLES,
  TELEGRAM_COMMAND_GROUPS,
  TELEGRAM_COMMAND_REFERENCE_TIPS,
  TELEGRAM_COVERAGE_SENTENCE,
  TELEGRAM_FAQ,
  TELEGRAM_PAGE_DESCRIPTION,
} from "./telegram-content";
import { ACTIVE_STABLECOIN_COUNT, TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
} from "@shared/lib/telegram-alert-families";
import type { TelegramAlertType } from "@shared/types/status";
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

  it("keeps retired features and commands out of the public copy", () => {
    const copy = JSON.stringify([
      TELEGRAM_PAGE_DESCRIPTION,
      TELEGRAM_ACTIONS,
      MINI_APP_FEATURES,
      TELEGRAM_ALERT_EXAMPLES.map((alert) => alert.tagline),
      TELEGRAM_COMMAND_REFERENCE_TIPS,
      TELEGRAM_FAQ,
      buildTelegramPageJsonLd("https://pharos.watch"),
    ]);
    for (const retired of [/recap/i, /launch alert/i, /\bpresets tab/i, /export|import/i, /\/(mute|unmutehours|timezone|presets|set|top|brief|why|health)\b/]) {
      expect(copy).not.toMatch(retired);
    }
    expect(copy).toMatch(/daily Changes message/);
    expect(copy).toMatch(/Fewer like this/);
    expect(copy).toContain(`at most ${TELEGRAM_ALERT_POLICY.chatCap.maxRealtimeMessages} live alerts a day`);
    expect(copy).toContain(`${String(TELEGRAM_ALERT_POLICY.rollup.localHour).padStart(2, "0")}:00`);
  });

  it("scopes market-wide roll-up copy to the policy's roll-up-only families", () => {
    const answer = TELEGRAM_FAQ.find(
      (item) => item.question === "Can I follow every active stablecoin at once?",
    )!.answer;
    const groupedClause = answer.match(/Market-wide [^.]*grouped into the daily Changes message/i)?.[0].toLowerCase() ?? "";
    const rollupOnly = TELEGRAM_ALERT_POLICY.rollupOnlyGlobalFamilies as readonly TelegramAlertType[];
    expect(groupedClause).not.toBe("");
    for (const family of rollupOnly) {
      expect(groupedClause).toContain(TELEGRAM_ALERT_FAMILY_SHORT_LABELS[family].toLowerCase());
    }
    for (const { key } of TELEGRAM_ALERT_FAMILIES) {
      if (rollupOnly.includes(key)) continue;
      expect(groupedClause).not.toContain(TELEGRAM_ALERT_FAMILY_SHORT_LABELS[key].toLowerCase());
    }
  });

  it("keeps live families out of the daily Changes copy and names the global DEWS case", () => {
    const taglineFor = (key: string) => TELEGRAM_ALERT_EXAMPLES.find((example) => example.key === key)!.tagline;
    // Reserve drift routes live to direct and global followers.
    expect(taglineFor("reserve")).toMatch(/sent live/i);
    expect(taglineFor("reserve")).not.toMatch(/daily Changes message/);
    const alertsAnswer = TELEGRAM_FAQ.find(
      (item) => item.question === "What alerts does Pharos send on Telegram?",
    )!.answer;
    expect(alertsAnswer).toMatch(/Live alerts cover[^.]*reserve drift/i);
    expect(alertsAnswer).not.toMatch(/reserve changes are grouped/);
    // A roll-up-only family's live tagline must still name the global opt-in.
    expect(taglineFor("dews")).toMatch(/Sent live/);
    expect(taglineFor("dews")).toMatch(/All stablecoins/);
  });

  it("scopes alert coverage to the active alerting universe", () => {
    expect(TELEGRAM_COVERAGE_SENTENCE).toContain(
      `${ACTIVE_STABLECOIN_COUNT.toLocaleString("en-US")} active stablecoins`,
    );
    expect(TELEGRAM_COVERAGE_SENTENCE).not.toContain(
      `${TRACKED_STABLECOIN_COUNT.toLocaleString("en-US")} tracked stablecoins`,
    );
    expect(TELEGRAM_FAQ.some((item) => item.question === "Can I follow every active stablecoin at once?")).toBe(true);
    expect(TELEGRAM_FAQ.some((item) => /every tracked stablecoin/i.test(item.question))).toBe(false);
  });

  it("emits SoftwareApplication markup and no retired HowTo node", () => {
    const types = buildTelegramPageJsonLd("https://pharos.watch").map((node) => node["@type"]);
    expect(types).toEqual(["SoftwareApplication"]);
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
