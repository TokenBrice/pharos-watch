import { makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_PERSISTENCE as PERSIST } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES as ALERT_TYPES } from "@shared/types/status";
import { formatTelegramCompactUsd as fmtUsd, formatTelegramSignedCompactUsd as fmtSUsd } from "../../common/telegram-format";
import { TELEGRAM_PRESET_LABEL_BY_ID as PRESETS } from "../../common/presets";
import { loadSubscriptionRowsByChat } from "../../store/subscriptions";
import { buildListMessage, buildNotFoundMessage, buildStatusMessage as statusMsg, describeGlobalAlertSettings as descGlobal, describeSubscriptionSettings as descSub, formatTelegramSafety } from "../telegram-webhook-messages";
import type { SubscriberRow, SubscriptionRow } from "../telegram-webhook-shared";
import type { StatusForCoin } from "../telegram-webhook-status";

const mkSub = (id: string, ov: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  stablecoin_id: id, alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_reserve: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, ...ov,
});
const allOff: Partial<SubscriptionRow> = { alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_reserve: 0, alert_freeze: 0 };
const allOv: Partial<SubscriptionRow> = { alert_dews_override: 1, alert_depeg_override: 1, alert_safety_override: 1, alert_launch_override: 1, alert_reserve_override: 1, alert_freeze_override: 1 };
const mkSubr = (ov: Partial<SubscriberRow> = {}): SubscriberRow => ({
  alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 0, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, ...ov,
});
const baseStatus = (ov: Partial<StatusForCoin> = {}): StatusForCoin => ({
  stablecoinId: "usdc-circle", priceUsd: 1, priceUpdatedAt: Math.floor(Date.now() / 1000), supplyUsd: null, supplyObservedAt: null, supplyCurrent: false, dews: null, safety: null, safetyUnavailableReason: null, liquidity: null, yield: null, flow: null, depeg: { status: "stable" }, ...ov,
});

describe("buildNotFoundMessage", () => {
  it("escapes HTML in ticker", () => {
    const m = buildNotFoundMessage("<script>"); expect(m).not.toContain("<script>"); expect(m).toContain("&lt;script&gt;");
  });
});

describe("describeSubscriptionSettings", () => {
  const N = 1_700_000_000;
  it("shows all types", () => {
    expect(descSub(mkSub("x", { alert_depeg: 1, alert_safety: 1, alert_launch: 1, alert_reserve: 1, alert_freeze: 1 }))).toBe("DEWS, Depeg, Safety, Reserve, Freeze");
  });
  it("shows inherited defaults when no types or overrides are enabled", () => {
    expect(descSub(mkSub("x", { alert_dews: 0 }))).toBe("via preset");
  });
  it("appends a snooze countdown when alert_snooze_until_ts is in the future (P1-U10)", () => {
    expect(descSub(mkSub("x", { alert_snooze_until_ts: N + 38 * 60 }), N)).toBe("DEWS · snoozed 38 min");
  });
  it("ignores an expired alert_snooze_until_ts", () => {
    expect(descSub(mkSub("x", { alert_snooze_until_ts: N - 60 }), N)).toBe("DEWS");
  });
  it("distinguishes snooze-only inheritance, one-family off, and fully explicit muting", () => {
    const r = mkSub("x", { ...allOff, alert_snooze_until_ts: N + 3600 });
    expect(descSub(r, N, { perCoinTag: true })).toBe("via preset · snoozed 1 h");
    expect(descSub({ ...r, alert_depeg_override: 1 }, N + 3600, { perCoinTag: true })).toBe("via preset · Depeg off");
    expect(descSub({ ...r, ...allOv }, N + 3600, { perCoinTag: true })).toBe("All alerts off");
  });
});

describe("describeSubscriptionSettings list override projection", () => {
  const NOW = 1_800_000_000, fx = createLatestSchemaFixtureTracker();
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
  afterEach(() => { fx.closeAll(); vi.useRealTimers(); });

  it.each(["snooze-only", "unmarked", "depeg-off", "all-off"])("matches post-snooze inherited eligibility for %s", async (mode) => {
    const { sqlite, db } = fx.open();
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_depeg, global_alert_freeze) VALUES ('42', ?, ?, 1, 1)").run(NOW, NOW);
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts) VALUES ('42', 'usdc-circle', ?)").run(mode === "snooze-only" ? NOW + 3600 : null);
    if (mode === "depeg-off" || mode === "all-off") {
      const cols = mode === "all-off" ? ALERT_TYPES.map((f) => PERSIST[f].overrideColumn) : [PERSIST.depeg.overrideColumn];
      sqlite.prepare(`UPDATE telegram_subscriptions SET ${cols.map((c) => `${c} = 1`).join(", ")} WHERE chat_id = '42'`).run();
    }
    const [row] = await loadSubscriptionRowsByChat(db, "42"), desc = descSub(row, NOW, { perCoinTag: true });
    if (mode === "all-off") expect(desc).toBe("All alerts off");
    else { expect(desc).toContain("via preset"); expect(desc).not.toContain("All alerts off"); }
    if (mode === "depeg-off") expect(desc).toContain("Depeg off");
    if (mode === "snooze-only") expect(desc).toContain("snoozed 1 h");
  });
});

describe("describeGlobalAlertSettings", () => {
  it("lists enabled global types", () => {
    expect(descGlobal(mkSubr({ global_alert_dews: 1, global_alert_safety: 1, global_alert_launch: 1, global_alert_reserve: 1, global_alert_freeze: 1 }))).toBe("DEWS, Safety downgrades of 3+ points, Reserve, Freeze");
  });
});

describe("buildListMessage", () => {
  const NOON = Math.floor(Date.UTC(2024, 0, 15, 12, 0, 0) / 1000), NIGHT = Math.floor(Date.UTC(2024, 0, 15, 2, 30, 0) / 1000);
  const quiet = mkSubr({ global_alert_dews: 1, global_alert_launch: 0, quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7 });
  const list = (i: Partial<Parameters<typeof buildListMessage>[0]>, nowSec = NOON) => buildListMessage({ subscriber: null, subscriptions: [], presetSubscriptions: [], presetLabelById: PRESETS, nowSec, ...i });

  it("names presets by label and global follows in plain words", () => {
    const m = list({ subscriber: quiet, presetSubscriptions: [{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: null }] });
    expect(m).toContain("<b>USD Top 25</b> (preset, updates with market cap): DEWS, Depeg");
    expect(m).toContain("<b>All stablecoins:</b> DEWS"); expect(m).toContain("Quiet hours 22:00-07:00 UTC");
    expect(m).not.toMatch(/usd-top25|Precedence|\/presets/);
  });

  it("renders an active pause with relative remaining time", () => {
    const m = list({ subscriber: { ...quiet, quiet_hours_enabled: 0, alert_snooze_until_ts: NOON + 38 * 60 } });
    expect(m).toContain("Alerts are paused for 38 min more."); expect(m).not.toContain("Quiet hours");
  });

  it("renders quiet hours as active when inside the window, in the subscriber timezone", () => {
    expect(list({ subscriber: quiet }, NIGHT)).toContain("Quiet hours active until 07:00 UTC");
    expect(list({ subscriber: { ...quiet, quiet_hours_start_utc: 13, quiet_hours_end_utc: 14, timezone: "Europe/Paris" } })).toContain("Quiet hours active until 14:00 Europe/Paris");
  });

  it("lists followed coins one per line by symbol and fully off coins separately", () => {
    const m = list({ subscriptions: [mkSub("usdc-circle", { alert_dews: 0, ...allOv }), mkSub("dai-makerdao")] });
    expect(m).toContain("<b>Coins (1):</b>\n• DAI — DEWS"); expect(m).toContain("<b>Alerts off:</b> USDC"); expect(m).not.toContain("dai-makerdao");
  });

  it("does not label a coin alerts-off while its unmarked zeroes inherit global follows", () => {
    const m = list({ subscriber: mkSubr({ global_alert_depeg: 1 }), subscriptions: [mkSub("usdc-circle", { alert_dews: 0, alert_dews_override: 1 })] });
    expect(m).toContain("<b>Coins (1):</b>\n• USDC — via preset · DEWS off");
    expect(m).not.toContain("<b>Alerts off:</b>");
  });
});

describe("buildStatusMessage 24h mint/burn flow (C122)", () => {
  const now = Math.floor(Date.now() / 1000);
  const fl = (netFlowUsd: number, age = 0) => ({ netFlowUsd, updatedAt: now - age, stale: age > 21_600, assessedAt: now, freshBudgetSec: 21_600 });
  it.each([[12_300_000, "+$12.3M"], [0, "$0"], [-4_000_000, "-$4.0M"]])("renders signed net flow %s", (v, exp) => {
    expect(statusMsg("USDC", baseStatus({ supplyUsd: 1, flow: fl(v) }), now)).toContain(`<b>24h flow:</b> ${exp}`);
  });
  it("omits the flow for untracked coins without an n/a placeholder", () => {
    expect(statusMsg("USDC", baseStatus({ flow: null }), now)).not.toContain("24h flow");
  });
  it("shows the flow's real age instead of a freshness verdict", () => {
    const m = statusMsg("USDC", baseStatus({ supplyUsd: 1, flow: fl(123_500, 7 * 3600) }), now);
    expect(m).toContain("<b>24h flow:</b> +$123.5K (updated 7h ago)"); expect(m).not.toMatch(/stale|fresh/);
  });
});

describe("buildStatusMessage supply and DEX context", () => {
  const now = Math.floor(Date.now() / 1000);
  it.each([[0.000055164025388120685, "$0.00005516"], [0.0000431234, "$0.00004312"]])("preserves the observed precision of a sub-cent price (%s)", (priceUsd, exp) => {
    expect(statusMsg("IDRX", baseStatus({ priceUsd }), now)).toContain(exp);
  });
  it("states unavailable liquidity and supply instead of omitting them or showing $0", () => {
    const m = statusMsg("USDC", baseStatus({ liquidity: null, liquidityUnavailableReason: "invalid-coverage-evidence", supplyUsd: null }), now);
    expect(m).toContain("<b>DEX liquidity:</b> not available right now"); expect(m).toContain("<b>Supply:</b> not available right now");
    expect(m).not.toContain("invalid-coverage-evidence"); expect(m).not.toContain("Supply:</b> $0");
  });
  it("keeps an explicit zero supply and shows each value's age", () => {
    expect(statusMsg("USDC", baseStatus({ supplyUsd: 0, supplyObservedAt: now, supplyCurrent: true }), now)).toContain("<b>Supply:</b> $0, updated just now");
    const old = statusMsg("USDC", baseStatus({ supplyUsd: 5e9, supplyObservedAt: now - 30 * 86_400, liquidity: { score: 91, totalTvlUsd: 123e6, updatedAt: now - 30 * 86_400, current: false } }), now);
    expect(old).toContain("<b>Supply:</b> $5.0B, updated 30d ago"); expect(old).toContain("<b>DEX liquidity:</b> $123.0M (score 91/100), updated 30d ago");
  });
});

describe("buildStatusMessage safety", () => {
  const safe = (ov: Partial<NonNullable<StatusForCoin["safety"]>> = {}): NonNullable<StatusForCoin["safety"]> => ({
    grade: "A", ratingStatus: "rated", partialEvidence: null, score: 90, model: "v9", methodologyVersion: "10.26", publicationGenerationId: "report-cards:v9:123", publishedAt: Math.floor(Date.now() / 1000), recordedAt: Math.floor(Date.now() / 1000), ...ov,
  });
  it("renders the grade without model, version, or generation ids", () => {
    const m = statusMsg("USDC", baseStatus({ safety: safe() }));
    expect(m).toContain("<b>Safety:</b> A (90)"); expect(m).not.toMatch(/V9|10\.26|report-cards/);
    expect(statusMsg("USDC", baseStatus({ safetyUnavailableReason: "canonical-snapshot-unavailable" }))).toContain("<b>Safety:</b> not available right now");
  });
  it.each(["pipeline-gap", "rated", "not-rated"] as const)("keeps %s availability distinct from its grade", (rs) => {
    const v = safe({ grade: rs === "pipeline-gap" ? null : rs === "not-rated" ? "NR" : "A", score: rs === "rated" ? 80 : null, ratingStatus: rs, partialEvidence: rs === "not-rated" ? null : { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: rs === "pipeline-gap" ? ["backing", "exit"] : ["exit"], causes: ["A"] } });
    const m = statusMsg("USDC", baseStatus({ safety: v }));
    expect(m).toContain(`<b>Safety:</b> ${formatTelegramSafety(v)}`);
    if (rs === "pipeline-gap") { expect(m).toContain("<b>Safety:</b> not available right now"); expect(m).not.toContain("(0)"); }
    else if (rs === "rated") expect(m).toContain("<b>Safety:</b> A (80), some inputs missing");
    else { expect(m).toContain("<b>Safety:</b> NR"); expect(m).not.toContain("some inputs missing"); }
  });
  it("reports tokenized funds as not graded rather than NR or unavailable", () => {
    const m = statusMsg("BUIDL", baseStatus({ stablecoinId: "buidl-blackrock", safety: safe({ grade: "NR", score: null, ratingStatus: "not-rated" }) }));
    expect(m).toContain("<b>Safety:</b> Tokenized fund (not graded)");
    expect(m).not.toContain("Safety grade");
  });
});

describe("buildStatusMessage yield", () => {
  it("escapes provider-controlled yield source text", () => {
    const m = statusMsg("USDC", baseStatus({ yield: { currentApy: 4.8, apy30d: 4.2, source: 'Morpho: Safe Vault <a href="https://attacker.example/phish">CLAIM</a> & <b>verified</b>', pharosYieldScore: 42, provenance: makeYieldProvenance({ sourceFreshness: "fresh" }), generationId: "yield-test" } }));
    expect(m).toContain("Morpho: Safe Vault &lt;a href=&quot;https://attacker.example/phish&quot;&gt;CLAIM&lt;/a&gt; &amp; &lt;b&gt;verified&lt;/b&gt;");
    expect(m).not.toContain('<a href="https://attacker.example/phish">');
  });
  it("names the source age and never a generation id or budget", () => {
    const obsAt = Math.floor(Date.now() / 1000) - 3600;
    const m = statusMsg("USDC", baseStatus({ yield: { currentApy: 4.8, apy30d: 4.2, source: "Accepted venue", pharosYieldScore: null, pysUnavailableReason: "source-stale", generationId: "yield-retained", provenance: makeYieldProvenance({ sourceObservedAt: obsAt, sourceMaxAgeSeconds: 7200, sourceFreshness: "stale" }) } }));
    expect(m).toContain("<b>Yield:</b> 4.20% (30-day, Accepted venue), updated 1h ago"); expect(m).not.toMatch(/yield-retained|budget|source-stale/);
  });
  it("states a failed yield read but omits the line for coins without yield", () => {
    expect(statusMsg("USDC", baseStatus({ yieldUnavailableReason: "yield-rankings-unavailable" }))).toContain("<b>Yield:</b> not available right now");
    expect(statusMsg("USDC", baseStatus({ yieldUnavailableReason: "yield-ranking-not-found" }))).not.toContain("Yield");
  });
});

describe("Telegram compact USD formatting", () => {
  it("preserves user-visible tier and sign bytes", () => {
    expect([fmtUsd(1.25e12), fmtUsd(2.5e9), fmtUsd(3.5e6), fmtUsd(4_500), fmtUsd(999), fmtUsd(-2.5e6), fmtSUsd(2.5e6), fmtSUsd(-2.5e6)]).toEqual(["$1250.0B", "$2.5B", "$3.5M", "$4.5K", "$999", "$-2.5M", "+$2.5M", "-$2.5M"]);
  });
  it("returns null for nullish and non-finite values", () => {
    expect([fmtUsd(null), fmtUsd(Infinity), fmtSUsd(undefined), fmtSUsd(NaN)]).toEqual([null, null, null, null]);
  });
});
