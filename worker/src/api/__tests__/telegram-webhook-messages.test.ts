import { describe, it, expect } from "vitest";
import {
  buildNotFoundMessage,
  buildUnsubscribeSuccessMessage,
  buildSubscriptionSummaryMessage,
  buildListMessage,
  describeSubscriptionSettings,
  describeGlobalAlertSettings,
  formatQuietHours,
} from "../telegram-webhook-messages";
import type { SubscriberRow, SubscriptionRow } from "../telegram-webhook-shared";

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
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 1, alert_safety: 1, alert_launch: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("DEWS, Depeg, Safety, Launch");
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
});

describe("describeGlobalAlertSettings", () => {
  it("returns None for null subscriber", () => {
    expect(describeGlobalAlertSettings(null)).toBe("None");
  });

  it("lists enabled global types", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 1,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    expect(describeGlobalAlertSettings(sub)).toBe("DEWS, Safety, Launch");
  });
});

describe("formatQuietHours", () => {
  it("formats hours as HH:00–HH:00 UTC", () => {
    expect(formatQuietHours(2, 7)).toBe("02:00–07:00 UTC");
    expect(formatQuietHours(22, 7)).toBe("22:00–07:00 UTC");
  });

  it("returns Off for null values", () => {
    expect(formatQuietHours(null, null)).toBe("Off");
    expect(formatQuietHours(22, null)).toBe("Off");
  });
});

describe("buildListMessage", () => {
  it("shows no subscriptions message when empty", () => {
    expect(buildListMessage(null, [])).toContain("No active subscriptions");
  });

  it("includes global settings and coin list", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
    };
    const msg = buildListMessage(sub, []);
    expect(msg).toContain("DEWS");
    expect(msg).toContain("22:00–07:00 UTC");
    expect(msg).toContain("Coins (0)");
  });
});
