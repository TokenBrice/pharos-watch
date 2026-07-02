import { describe, it, expect } from "vitest";
import {
  MANAGE_PAGE_SIZE,
  buildListMessage,
  buildManageEntryKeyboard,
  buildManageWatchlistKeyboard,
  buildManageWatchlistMessage,
  buildNotFoundMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeSuccessMessage,
  describeGlobalAlertSettings,
  describeSubscriptionSettings,
  formatQuietHours,
} from "../telegram-webhook-messages";
import type { SubscriberRow, SubscriptionRow } from "../telegram-webhook-shared";

function makeSubscriptionRow(stablecoinId: string): SubscriptionRow {
  return {
    stablecoin_id: stablecoinId,
    alert_dews: 1,
    alert_depeg: 0,
    alert_safety: 0,
    alert_launch: 0,
    alert_reserve: 0,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
  };
}

describe("buildNotFoundMessage", () => {
  it("includes the unknown ticker", () => {
    const msg = buildNotFoundMessage("XYZZY");
    expect(msg).toContain("XYZZY");
    expect(msg).toContain("not found");
  });

  it("includes suggestion when provided", () => {
    const msg = buildNotFoundMessage("UDS", { id: "usdc-circle", symbol: "USDC", name: "USD Coin" });
    expect(msg).toContain("USDC");
    expect(msg).toContain("Did you mean");
  });

  it("escapes HTML in ticker", () => {
    const msg = buildNotFoundMessage("<script>");
    expect(msg).not.toContain("<script>");
    expect(msg).toContain("&lt;script&gt;");
  });
});

describe("buildUnsubscribeSuccessMessage", () => {
  it("reports correct count for single coin", () => {
    const msg = buildUnsubscribeSuccessMessage([{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }]);
    expect(msg).toContain("1 coin subscription");
    expect(msg).not.toContain("subscriptions");
  });

  it("reports correct count for multiple coins", () => {
    const msg = buildUnsubscribeSuccessMessage([
      { id: "usdc-circle", symbol: "USDC", name: "USD Coin" },
      { id: "dai-maker", symbol: "DAI", name: "Dai" },
    ]);
    expect(msg).toContain("2 coin subscriptions");
  });
});

describe("buildSubscriptionSummaryMessage", () => {
  it("includes header and formatted subscription rows", () => {
    const subscriptions: SubscriptionRow[] = [
      {
        stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
        dews_min_band: "WARNING", safety_mode: null, depeg_worsening_bps_step: null,
      },
    ];
    const msg = buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions);
    expect(msg).toContain("Updated subscriptions.");
    expect(msg).toContain("Coins (1)");
    expect(msg).toContain("DEWS&gt;=WARNING");
  });
});

describe("describeSubscriptionSettings", () => {
  it("shows DEWS with min band", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: "WARNING", safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("DEWS>=WARNING");
  });

  it("shows all types", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 1, alert_safety: 1, alert_launch: 1, alert_reserve: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("DEWS, Depeg, Safety, Launch, Reserve");
  });

  it("shows reserve as an enabled per-coin alert type", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_reserve: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("Reserve");
  });

  it("shows Muted when no types enabled", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("Muted");
  });

  it("shows safety mode", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 0, alert_safety: 1, alert_launch: 0,
      dews_min_band: null, safety_mode: "downgrade-only", depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("Safety downgrade-only");
  });

  it("shows depeg step", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 1, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: 250,
    };
    expect(describeSubscriptionSettings(row)).toBe("Depeg +250bps");
  });

  it("appends a snooze countdown when alert_snooze_until_ts is in the future (P1-U10)", () => {
    const nowSec = 1_700_000_000;
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
      alert_snooze_until_ts: nowSec + 38 * 60,
    };
    expect(describeSubscriptionSettings(row, nowSec)).toBe("DEWS — snoozed for 38 min");
  });

  it("ignores an expired alert_snooze_until_ts", () => {
    const nowSec = 1_700_000_000;
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
      alert_snooze_until_ts: nowSec - 60,
    };
    expect(describeSubscriptionSettings(row, nowSec)).toBe("DEWS");
  });

  it("renders an all-flags-0 row as a muted override under perCoinTag (C74)", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row, undefined, { perCoinTag: true })).toBe("Muted (overrides defaults)");
  });

  it("tags a flagged row as per-coin under perCoinTag (C74)", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row, undefined, { perCoinTag: true })).toBe("DEWS · per-coin");
  });

  it("keeps the snooze suffix alongside the per-coin tag (C74)", () => {
    const nowSec = 1_700_000_000;
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
      alert_snooze_until_ts: nowSec + 38 * 60,
    };
    expect(describeSubscriptionSettings(row, nowSec, { perCoinTag: true })).toBe("DEWS · per-coin — snoozed for 38 min");
  });
});

describe("describeGlobalAlertSettings", () => {
  it("returns None for null subscriber", () => {
    expect(describeGlobalAlertSettings(null)).toBe("None");
  });

  it("lists enabled global types", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 1,
      global_alert_reserve: 1,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    expect(describeGlobalAlertSettings(sub)).toBe("DEWS, Safety (downgrades; 3-point drop when scored), Launch, Reserve");
  });

  it("shows reserve as an enabled global alert type", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      global_alert_reserve: 1,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    expect(describeGlobalAlertSettings(sub)).toBe("Reserve");
  });

  it("shows the global depeg worsening step when configured", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 0, global_alert_depeg: 1, global_alert_safety: 0, global_alert_launch: 0,
      global_depeg_worsening_bps_step: 250,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    expect(describeGlobalAlertSettings(sub)).toBe("Depeg +250bps");
  });
});

describe("formatQuietHours", () => {
  it("formats hours as HH:00–HH:00 UTC", () => {
    expect(formatQuietHours(2, 7)).toBe("02:00–07:00 UTC");
    expect(formatQuietHours(22, 7)).toBe("22:00–07:00 UTC");
  });

  it("formats hours with the configured timezone when present", () => {
    expect(formatQuietHours(2, 7, "Europe/Paris")).toBe("02:00–07:00 Europe/Paris");
  });

  it("returns Off for null values", () => {
    expect(formatQuietHours(null, null)).toBe("Off");
    expect(formatQuietHours(22, null)).toBe("Off");
  });
});

describe("buildListMessage", () => {
  // Pin "now" to noon UTC on 2024-01-15 so quiet-hours/snooze rendering is deterministic.
  const NOON_UTC_SEC = Math.floor(Date.UTC(2024, 0, 15, 12, 0, 0) / 1000);
  // 02:30 UTC on the same date — inside a 22:00–07:00 quiet window.
  const NIGHT_UTC_SEC = Math.floor(Date.UTC(2024, 0, 15, 2, 30, 0) / 1000);

  it("shows no subscriptions message when empty", () => {
    expect(buildListMessage(null, [])).toContain("No active subscriptions");
  });

  it("includes global settings and coin list", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
    };
    const msg = buildListMessage(sub, [], [], NOON_UTC_SEC);
    expect(msg).toContain("DEWS");
    expect(msg).toContain("22:00–07:00 UTC");
    expect(msg).toContain("Coins (0)");
  });

  it("renders an active snooze with relative remaining time", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
      alert_snooze_until_ts: NOON_UTC_SEC + 38 * 60,
    };
    const msg = buildListMessage(sub, [], [], NOON_UTC_SEC);
    expect(msg).toContain("Snoozed for 38 min");
    expect(msg).not.toContain("Snooze: Off");
    expect(msg).toContain("Quiet hours: Off");
  });

  it("renders quiet hours as active when inside the window", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
    };
    const msg = buildListMessage(sub, [], [], NIGHT_UTC_SEC);
    expect(msg).toContain("Quiet hours: active until 07:00 UTC");
    expect(msg).not.toContain("22:00–07:00 UTC");
    expect(msg).toContain("Snooze: Off");
  });

  it("evaluates active quiet hours in the subscriber timezone", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 13, quiet_hours_end_utc: 14,
      timezone: "Europe/Paris",
    };
    const msg = buildListMessage(sub, [], [], NOON_UTC_SEC);
    expect(msg).toContain("Quiet hours: active until 14:00 Europe/Paris");
    expect(msg).not.toContain("13:00–14:00 UTC");
  });

  it("renders quiet hours as a window when outside it", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
    };
    const msg = buildListMessage(sub, [], [], NOON_UTC_SEC);
    expect(msg).toContain("Quiet hours: 22:00–07:00 UTC");
    expect(msg).not.toContain("active until");
    expect(msg).toContain("Snooze: Off");
  });

  it("shows a per-coin snooze countdown next to each affected coin (P1-U10)", () => {
    const sub: SubscriberRow = {
      alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    const subscription: SubscriptionRow = {
      stablecoin_id: "usdc-circle",
      alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
      alert_snooze_until_ts: NOON_UTC_SEC + 2 * 3600,
    };
    const msg = buildListMessage(sub, [subscription], [], NOON_UTC_SEC);
    expect(msg).toContain("snoozed for 2 h");
  });

  it("includes the precedence note even for an empty subscriber (C74)", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    const msg = buildListMessage(sub, [], [], NOON_UTC_SEC);
    expect(msg).toContain("Precedence: per-coin &gt; preset &gt; all-stablecoins.");
    expect(msg).toContain("A per-coin Muted overrides the rest.");
  });

  it("renders an all-flags-0 coin row as a muted override and tags flagged rows (C74)", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    const mutedRow: SubscriptionRow = {
      stablecoin_id: "usdc-circle",
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    const flaggedRow: SubscriptionRow = {
      stablecoin_id: "dai-makerdao",
      alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    const msg = buildListMessage(sub, [mutedRow, flaggedRow], [], NOON_UTC_SEC);
    expect(msg).toContain("Muted (overrides defaults)");
    expect(msg).toContain("DEWS · per-coin");
  });
});

describe("buildManageEntryKeyboard", () => {
  it("emits a single Manage button starting at page 0", () => {
    const kb = buildManageEntryKeyboard();
    expect(kb.inline_keyboard).toEqual([[{ text: "Manage", callback_data: "manage:page:0" }]]);
  });
});

describe("buildManageWatchlistKeyboard", () => {
  it("renders one row per coin with a ❌ + symbol label and unsub callback", () => {
    const subs = [makeSubscriptionRow("usdc-circle"), makeSubscriptionRow("dai-makerdao")];
    const kb = buildManageWatchlistKeyboard(subs, 0);
    // Sorted alphabetically by symbol: DAI then USDC.
    expect(kb.inline_keyboard[0]).toEqual([{ text: "❌ DAI", callback_data: "unsub:dai-makerdao" }]);
    expect(kb.inline_keyboard[1]).toEqual([{ text: "❌ USDC", callback_data: "unsub:usdc-circle" }]);
    // No nav row when everything fits on one page.
    expect(kb.inline_keyboard).toHaveLength(2);
  });

  it("paginates at MANAGE_PAGE_SIZE per page and adds Prev/Next nav", () => {
    // Pick 7 known tracked ids so MANAGE_PAGE_SIZE=5 yields two pages.
    const ids = [
      "usdc-circle",
      "usdt-tether",
      "dai-makerdao",
      "frax-frax",
      "tusd-trueusd",
      "lusd-liquity",
      "susd-synthetix",
    ];
    const subs = ids.map(makeSubscriptionRow);

    const page0 = buildManageWatchlistKeyboard(subs, 0);
    const coinRows0 = page0.inline_keyboard.slice(0, MANAGE_PAGE_SIZE);
    expect(coinRows0).toHaveLength(MANAGE_PAGE_SIZE);
    // Page 0 has only a Next button.
    const navRow0 = page0.inline_keyboard[page0.inline_keyboard.length - 1];
    expect(navRow0.some((b) => b.callback_data === "manage:page:1" && b.text.includes("Next"))).toBe(true);
    expect(navRow0.some((b) => b.text.includes("Prev"))).toBe(false);

    const page1 = buildManageWatchlistKeyboard(subs, 1);
    // Last page: only Prev nav.
    const navRow1 = page1.inline_keyboard[page1.inline_keyboard.length - 1];
    expect(navRow1.some((b) => b.callback_data === "manage:page:0" && b.text.includes("Prev"))).toBe(true);
    expect(navRow1.some((b) => b.text.includes("Next"))).toBe(false);
  });

  it("clamps an out-of-range page index to the last valid page", () => {
    const subs = [makeSubscriptionRow("usdc-circle"), makeSubscriptionRow("dai-makerdao")];
    const kb = buildManageWatchlistKeyboard(subs, 99);
    // Two coins, one page — no nav row, both rows present.
    expect(kb.inline_keyboard).toHaveLength(2);
  });
});

describe("buildManageWatchlistMessage", () => {
  it("returns an empty-state message when there are no subscriptions", () => {
    const msg = buildManageWatchlistMessage([], 0);
    expect(msg).toContain("No coin subscriptions to manage");
  });

  it("includes the count and page indicator", () => {
    const subs = Array.from({ length: 7 }, (_, i) =>
      makeSubscriptionRow(["usdc-circle", "usdt-tether", "dai-makerdao", "frax-frax", "tusd-trueusd", "lusd-liquity", "susd-synthetix"][i]),
    );
    const msg = buildManageWatchlistMessage(subs, 0);
    expect(msg).toContain("7 coins");
    expect(msg).toContain("Page 1/2");
  });
});
