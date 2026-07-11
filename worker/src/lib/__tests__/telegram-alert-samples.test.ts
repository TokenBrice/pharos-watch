import { describe, expect, it } from "vitest";
import { TELEGRAM_ALERT_TYPES, type TelegramAlertType } from "@shared/types/status/telegram";
import {
  TELEGRAM_ALERT_SAMPLE_FIXTURES,
  TELEGRAM_PUBLIC_ALERT_SAMPLES,
  telegramAlertHtmlToPublicText,
} from "@shared/lib/telegram-alert-samples";
import { formatConsolidatedMessage, type ConsolidatedAlerts } from "../telegram-alerts";

/**
 * TGB-028 public-sample drift contract: the /pharoswatchbot landing page
 * promises its alert examples are "shown exactly as the bot sends them".
 * Regenerate every public sample from the canonical fixtures through the real
 * formatter so any formatter change that invalidates the public copy fails
 * here instead of drifting silently.
 */

function emptyConsolidatedAlerts(): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
    reserve: [],
  };
}

function buildSingleFamilyAlerts(family: TelegramAlertType): ConsolidatedAlerts {
  const alerts = emptyConsolidatedAlerts();
  switch (family) {
    case "dews":
      alerts.dews = [TELEGRAM_ALERT_SAMPLE_FIXTURES.dews];
      break;
    case "depeg":
      alerts.depegTriggered = [TELEGRAM_ALERT_SAMPLE_FIXTURES.depeg];
      break;
    case "safety":
      alerts.safety = [TELEGRAM_ALERT_SAMPLE_FIXTURES.safety];
      break;
    case "launch":
      alerts.launch = [TELEGRAM_ALERT_SAMPLE_FIXTURES.launch];
      break;
    case "reserve":
      alerts.reserve = [TELEGRAM_ALERT_SAMPLE_FIXTURES.reserve];
      break;
  }
  return alerts;
}

describe("telegram public alert samples", () => {
  it("covers every alert family, including reserve", () => {
    expect(Object.keys(TELEGRAM_PUBLIC_ALERT_SAMPLES).sort()).toEqual([...TELEGRAM_ALERT_TYPES].sort());
    expect(Object.keys(TELEGRAM_ALERT_SAMPLE_FIXTURES).sort()).toEqual([...TELEGRAM_ALERT_TYPES].sort());
  });

  for (const family of TELEGRAM_ALERT_TYPES) {
    it(`matches the real formatter output for the ${family} sample`, () => {
      const html = formatConsolidatedMessage(buildSingleFamilyAlerts(family));
      expect(telegramAlertHtmlToPublicText(html)).toBe(TELEGRAM_PUBLIC_ALERT_SAMPLES[family].message);
    });
  }
});
