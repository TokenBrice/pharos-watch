import { makeSubscriptionRow } from "./telegram-rows.test-support.ts";
import { makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import { describe, it, expect } from "vitest";
import { formatTelegramCompactUsd, formatTelegramSignedCompactUsd } from "../../common/telegram-format";
import { TELEGRAM_PRESET_LABEL_BY_ID } from "../../common/presets";
import {
  buildListMessage,
  buildNotFoundMessage,
  buildStatusMessage,
  describeGlobalAlertSettings,
  describeSubscriptionSettings,
  formatTelegramSafety,
} from "../telegram-webhook-messages";
import type { SubscriberRow, SubscriptionRow } from "../telegram-webhook-shared";
import type { StatusForCoin } from "../telegram-webhook-status";


describe("buildNotFoundMessage", () => {
  it("escapes HTML in ticker", () => {
    const msg = buildNotFoundMessage("<script>");
    expect(msg).not.toContain("<script>");
    expect(msg).toContain("&lt;script&gt;");
  });
});

describe("describeSubscriptionSettings", () => {
  it("shows all types", () => {
    const row = makeSubscriptionRow("x", { alert_dews: 1, alert_depeg: 1, alert_safety: 1, alert_launch: 1, alert_reserve: 1, alert_freeze: 1,
    dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, });
    expect(describeSubscriptionSettings(row)).toBe("DEWS, Depeg, Safety, Reserve, Freeze");
  });

  it("shows inherited defaults when no types or overrides are enabled", () => {
    const row = makeSubscriptionRow("x", { alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, });
    expect(describeSubscriptionSettings(row)).toBe("Inherits preset/global defaults");
  });

  it("appends a snooze countdown when alert_snooze_until_ts is in the future (P1-U10)", () => {
    const nowSec = 1_700_000_000;
    const row = makeSubscriptionRow("x", { alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    alert_snooze_until_ts: nowSec + 38 * 60, });
    expect(describeSubscriptionSettings(row, nowSec)).toBe("DEWS — snoozed for 38 min");
  });

  it("ignores an expired alert_snooze_until_ts", () => {
    const nowSec = 1_700_000_000;
    const row = makeSubscriptionRow("x", { alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    alert_snooze_until_ts: nowSec - 60, });
    expect(describeSubscriptionSettings(row, nowSec)).toBe("DEWS");
  });

  it("distinguishes snooze-only inheritance, one-family off, and fully explicit muting", () => {
    const nowSec = 1_700_000_000;
    const row = makeSubscriptionRow("x", {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      alert_reserve: 0, alert_freeze: 0, alert_snooze_until_ts: nowSec + 3600,
    });
    expect(describeSubscriptionSettings(row, nowSec, { perCoinTag: true }))
      .toBe("Inherits preset/global defaults — snoozed for 1 h");
    expect(describeSubscriptionSettings({ ...row, alert_depeg_override: 1 }, nowSec + 3600, { perCoinTag: true }))
      .toBe("Inherits preset/global defaults; off: Depeg (overrides defaults)");
    expect(describeSubscriptionSettings({
      ...row, alert_dews_override: 1, alert_depeg_override: 1, alert_safety_override: 1,
      alert_launch_override: 1, alert_reserve_override: 1, alert_freeze_override: 1,
    }, nowSec + 3600, { perCoinTag: true })).toBe("Muted (overrides defaults)");
  });
});

describe("describeGlobalAlertSettings", () => {
  it("lists enabled global types", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 1,
      global_alert_reserve: 1,
      global_alert_freeze: 1,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    expect(describeGlobalAlertSettings(sub)).toBe("DEWS, Safety downgrades of 3+ points, Reserve, Freeze");
  });
});

describe("buildListMessage", () => {
  // Pin "now" to noon UTC on 2024-01-15 so quiet-hours/snooze rendering is deterministic.
  const NOON_UTC_SEC = Math.floor(Date.UTC(2024, 0, 15, 12, 0, 0) / 1000);
  // 02:30 UTC on the same date — inside a 22:00–07:00 quiet window.
  const NIGHT_UTC_SEC = Math.floor(Date.UTC(2024, 0, 15, 2, 30, 0) / 1000);
  const quietSubscriber: SubscriberRow = {
    alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
    global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
    quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
  };
  const list = (input: Partial<Parameters<typeof buildListMessage>[0]>, nowSec = NOON_UTC_SEC) => buildListMessage({
    subscriber: null, subscriptions: [], presetSubscriptions: [], presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID, nowSec, ...input,
  });

  it("names presets by label and global follows in plain words", () => {
    const msg = list({
      subscriber: quietSubscriber,
      presetSubscriptions: [{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: null }],
    });
    expect(msg).toContain("<b>USD Top 25</b> (preset, updates with market cap): DEWS, Depeg");
    expect(msg).toContain("<b>Every tracked coin:</b> DEWS");
    expect(msg).toContain("Quiet hours 22:00–07:00 UTC");
    expect(msg).not.toMatch(/usd-top25|Precedence|\/presets/);
  });

  it("renders an active pause with relative remaining time", () => {
    const msg = list({ subscriber: { ...quietSubscriber, quiet_hours_enabled: 0, alert_snooze_until_ts: NOON_UTC_SEC + 38 * 60 } });
    expect(msg).toContain("Alerts are paused for 38 min more.");
    expect(msg).not.toContain("Quiet hours");
  });

  it("renders quiet hours as active when inside the window, in the subscriber timezone", () => {
    expect(list({ subscriber: quietSubscriber }, NIGHT_UTC_SEC)).toContain("Quiet hours active until 07:00 UTC");
    expect(list({ subscriber: { ...quietSubscriber, quiet_hours_start_utc: 13, quiet_hours_end_utc: 14, timezone: "Europe/Paris" } }))
      .toContain("Quiet hours active until 14:00 Europe/Paris");
  });

  it("lists followed coins by symbol and fully muted coins separately", () => {
    const mutedRow: SubscriptionRow = {
      stablecoin_id: "usdc-circle",
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      alert_dews_override: 1, alert_depeg_override: 1, alert_safety_override: 1,
      alert_launch_override: 1, alert_reserve_override: 1, alert_freeze_override: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    const flaggedRow: SubscriptionRow = {
      stablecoin_id: "dai-makerdao",
      alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    const msg = list({ subscriptions: [mutedRow, flaggedRow] });
    expect(msg).toContain("<b>Coins:</b> DAI (DEWS)");
    expect(msg).toContain("<b>Muted:</b> USDC");
    expect(msg).not.toContain("dai-makerdao");
  });
});

function baseStatus(overrides: Partial<StatusForCoin> = {}): StatusForCoin {
  return {
    stablecoinId: "usdc-circle",
    priceUsd: 1,
    priceUpdatedAt: Math.floor(Date.now() / 1000),
    supplyUsd: null,
    supplyObservedAt: null,
    supplyCurrent: false,
    dews: null,
    safety: null,
    safetyUnavailableReason: null,
    liquidity: null,
    yield: null,
    flow: null,
    depeg: { status: "stable" },
    ...overrides,
  };
}

describe("buildStatusMessage 24h mint/burn flow (C122)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const flow = (netFlowUsd: number, ageSec = 0) => ({
    netFlowUsd, updatedAt: nowSec - ageSec, stale: ageSec > 21_600, assessedAt: nowSec, freshBudgetSec: 21_600,
  });

  it.each([[12_300_000, "+$12.3M"], [0, "$0"], [-4_000_000, "-$4.0M"]])("renders signed net flow %s", (value, expected) => {
    expect(buildStatusMessage("USDC", baseStatus({ supplyUsd: 1, flow: flow(value) }), nowSec)).toContain(`24h net flow ${expected}`);
  });

  it("omits the flow for untracked coins without an n/a placeholder", () => {
    expect(buildStatusMessage("USDC", baseStatus({ flow: null }), nowSec)).not.toContain("net flow");
  });

  it("shows the flow's real age instead of a freshness verdict", () => {
    const message = buildStatusMessage("USDC", baseStatus({ supplyUsd: 1, flow: flow(123_500, 7 * 3600) }), nowSec);
    expect(message).toContain("24h net flow +$123.5K (updated 7h ago)");
    expect(message).not.toMatch(/stale|fresh/);
  });
});

describe("buildStatusMessage supply and DEX context", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("states unavailable liquidity and supply instead of omitting them or showing $0", () => {
    const message = buildStatusMessage("USDC", baseStatus({
      liquidity: null, liquidityUnavailableReason: "invalid-coverage-evidence", supplyUsd: null,
    }), nowSec);
    expect(message).toContain("DEX liquidity not available right now");
    expect(message).toContain("Supply not available right now");
    expect(message).not.toContain("invalid-coverage-evidence");
    expect(message).not.toContain("Supply $0");
  });

  it("keeps an explicit zero supply and shows each value's age", () => {
    expect(buildStatusMessage("USDC", baseStatus({ supplyUsd: 0, supplyObservedAt: nowSec, supplyCurrent: true }), nowSec))
      .toContain("Supply $0, updated just now");
    const old = buildStatusMessage("USDC", baseStatus({
      supplyUsd: 5_000_000_000, supplyObservedAt: nowSec - 30 * 86_400,
      liquidity: { score: 91, totalTvlUsd: 123_000_000, updatedAt: nowSec - 30 * 86_400, current: false },
    }), nowSec);
    expect(old).toContain("Supply $5.0B, updated 30d ago");
    expect(old).toContain("DEX liquidity $123.0M (score 91/100), updated 30d ago");
  });
});

describe("buildStatusMessage safety", () => {
  const safety = (overrides: Partial<NonNullable<StatusForCoin["safety"]>> = {}): NonNullable<StatusForCoin["safety"]> => ({
    grade: "A", ratingStatus: "rated", partialEvidence: null, score: 90, model: "v9", methodologyVersion: "10.26",
    publicationGenerationId: "report-cards:v9:123", publishedAt: Math.floor(Date.now() / 1000), recordedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  });

  it("renders the grade without model, version, or generation ids", () => {
    const message = buildStatusMessage("USDC", baseStatus({ safety: safety() }));
    expect(message).toContain("Safety grade A (90)");
    expect(message).not.toMatch(/V9|10\.26|report-cards/);
    expect(buildStatusMessage("USDC", baseStatus({ safetyUnavailableReason: "canonical-snapshot-unavailable" })))
      .toContain("Safety grade not available right now");
  });

  it.each(["pipeline-gap", "rated", "not-rated"] as const)("keeps %s availability distinct from its grade", (ratingStatus) => {
    const value = safety({
      grade: ratingStatus === "pipeline-gap" ? null : ratingStatus === "not-rated" ? "NR" : "A",
      score: ratingStatus === "rated" ? 80 : null,
      ratingStatus,
      partialEvidence: ratingStatus === "not-rated" ? null : {
        reasonCode: "partial-evidence-pipeline-gap",
        excludedPillars: ratingStatus === "pipeline-gap" ? ["backing", "exit"] : ["exit"],
        causes: ["A"],
      },
    });
    const message = buildStatusMessage("USDC", baseStatus({ safety: value }));
    expect(message).toContain(`Safety grade ${formatTelegramSafety(value)}`);
    if (ratingStatus === "pipeline-gap") {
      expect(message).toContain("Safety grade not available right now");
      expect(message).not.toContain("(0)");
    } else if (ratingStatus === "rated") {
      expect(message).toContain("Safety grade A (80), some inputs missing");
    } else {
      expect(message).toContain("Safety grade NR");
      expect(message).not.toContain("some inputs missing");
    }
  });
});

describe("buildStatusMessage yield", () => {
  it("escapes provider-controlled yield source text", () => {
    const msg = buildStatusMessage(
      "USDC",
      baseStatus({
        yield: {
          currentApy: 4.8,
          apy30d: 4.2,
          source: 'Morpho: Safe Vault <a href="https://attacker.example/phish">CLAIM</a> & <b>verified</b>',
          pharosYieldScore: 42,
          provenance: makeYieldProvenance({ sourceFreshness: "fresh" }),
          generationId: "yield-test",
        },
      }),
    );
    expect(msg).toContain(
      "Morpho: Safe Vault &lt;a href=&quot;https://attacker.example/phish&quot;&gt;CLAIM&lt;/a&gt; &amp; &lt;b&gt;verified&lt;/b&gt;",
    );
    expect(msg).not.toContain('<a href="https://attacker.example/phish">');
  });

  it("names the source age and never a generation id or budget", () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    const msg = buildStatusMessage("USDC", baseStatus({
      yield: {
        currentApy: 4.8, apy30d: 4.2, source: "Accepted venue", pharosYieldScore: null,
        pysUnavailableReason: "source-stale", generationId: "yield-retained",
        provenance: makeYieldProvenance({ sourceObservedAt: observedAt, sourceMaxAgeSeconds: 7200, sourceFreshness: "stale" }),
      },
    }));
    expect(msg).toContain("Yield 4.20% (30-day, Accepted venue), updated 1h ago");
    expect(msg).not.toMatch(/yield-retained|budget|source-stale/);
  });

  it("states a failed yield read but omits the line for coins without yield", () => {
    expect(buildStatusMessage("USDC", baseStatus({ yieldUnavailableReason: "yield-rankings-unavailable" })))
      .toContain("Yield not available right now");
    expect(buildStatusMessage("USDC", baseStatus({ yieldUnavailableReason: "yield-ranking-not-found" })))
      .not.toContain("Yield");
  });
});

describe("Telegram compact USD formatting", () => {
  it("preserves user-visible tier and sign bytes", () => {
    expect(formatTelegramCompactUsd(1_250_000_000_000)).toBe("$1250.0B");
    expect(formatTelegramCompactUsd(2_500_000_000)).toBe("$2.5B");
    expect(formatTelegramCompactUsd(3_500_000)).toBe("$3.5M");
    expect(formatTelegramCompactUsd(4_500)).toBe("$4.5K");
    expect(formatTelegramCompactUsd(999)).toBe("$999");
    expect(formatTelegramCompactUsd(-2_500_000)).toBe("$-2.5M");
    expect(formatTelegramSignedCompactUsd(2_500_000)).toBe("+$2.5M");
    expect(formatTelegramSignedCompactUsd(-2_500_000)).toBe("-$2.5M");
  });

  it("returns null for nullish and non-finite values", () => {
    expect(formatTelegramCompactUsd(null)).toBeNull();
    expect(formatTelegramCompactUsd(Infinity)).toBeNull();
    expect(formatTelegramSignedCompactUsd(undefined)).toBeNull();
    expect(formatTelegramSignedCompactUsd(NaN)).toBeNull();
  });
});
