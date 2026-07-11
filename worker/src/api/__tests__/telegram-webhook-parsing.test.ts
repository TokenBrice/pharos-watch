import { describe, expect, it, vi } from "vitest";
import {
  parseCommand,
  parsePendingDisambiguation,
  parseSetCommand,
  parseStartPayload,
} from "../telegram-webhook-parsing";
import type { PendingDisambiguationRow } from "../telegram-webhook-shared";

function makePendingRow(overrides: Partial<PendingDisambiguationRow> = {}): PendingDisambiguationRow {
  return {
    action_type: "subscribe",
    action_payload: JSON.stringify({ alertTypes: ["dews"] }),
    alert_types: JSON.stringify(["dews"]),
    resolved_ids: JSON.stringify(["usdc-circle"]),
    ambiguous_ticker: "USDF",
    candidates: JSON.stringify([
      { id: "usdf-falcon", symbol: "USDF", name: "Falcon USD" },
      { id: "usdf-tradfi", symbol: "USDF", name: "TradFi USD" },
    ]),
    remaining_tickers: JSON.stringify(["USDC"]),
    expires_at: 1_700_000_000,
    initiator_user_id: "999",
    ...overrides,
  };
}

describe("parseCommand", () => {
  it("normalizes addressed group commands while preserving the bot mention", () => {
    expect(parseCommand("/subscribe@PharosWatchBot dews usd-top25")).toEqual({
      command: "/subscribe",
      args: "dews usd-top25",
      botMention: "pharoswatchbot",
    });
  });

  it("keeps unaddressed commands distinguishable from addressed commands", () => {
    expect(parseCommand("/help")).toEqual({
      command: "/help",
      args: "",
      botMention: null,
    });
  });
});

describe("parseSetCommand", () => {
  it("parses launch toggles", () => {
    expect(parseSetCommand("USDPT launch on")).toEqual({
      ticker: "USDPT",
      setting: "launch",
      enabled: true,
    });
    expect(parseSetCommand("all launch off")).toEqual({
      ticker: "all",
      setting: "launch",
      enabled: false,
    });
  });

  it("accepts `on` as an alias of `alert` for dews", () => {
    expect(parseSetCommand("USDC dews on")).toEqual({
      ticker: "USDC",
      setting: "dews",
      enabled: true,
      minBand: null,
    });
    expect(parseSetCommand("USDC dews alert")).toEqual({
      ticker: "USDC",
      setting: "dews",
      enabled: true,
      minBand: null,
    });
  });

  it("accepts `on` as an alias of `all` for safety", () => {
    expect(parseSetCommand("USDC safety on")).toEqual({
      ticker: "USDC",
      setting: "safety",
      enabled: true,
      mode: null,
    });
    expect(parseSetCommand("USDC safety all")).toEqual({
      ticker: "USDC",
      setting: "safety",
      enabled: true,
      mode: null,
    });
  });

  it("accepts the dews/safety `on` alias for global all-stablecoin writes", () => {
    expect(parseSetCommand("all dews on")).toEqual({
      ticker: "all",
      setting: "dews",
      enabled: true,
      minBand: null,
    });
    expect(parseSetCommand("all safety on")).toEqual({
      ticker: "all",
      setting: "safety",
      enabled: true,
      mode: null,
    });
  });

  it("still rejects truly invalid dews and safety values", () => {
    expect(parseSetCommand("USDC dews danger-only")).toEqual({
      error: "DEWS values: off, ALERT, WARNING, DANGER",
    });
    expect(parseSetCommand("USDC safety enabled")).toEqual({
      error: "Safety values: off, all, downgrade-only, upgrade-only",
    });
  });
});

describe("parseStartPayload", () => {
  it("returns none for empty payload", () => {
    expect(parseStartPayload("")).toEqual({ kind: "none" });
    expect(parseStartPayload("   ")).toEqual({ kind: "none" });
  });

  it("returns setup for the setup keyword", () => {
    expect(parseStartPayload("setup")).toEqual({ kind: "setup" });
    expect(parseStartPayload("SETUP")).toEqual({ kind: "setup" });
  });

  it("accepts only catalog-issued adoption tokens for the bot setup surface", () => {
    expect(parseStartPayload("pw1_landing_hero")).toEqual({
      kind: "adoption",
      token: "pw1_landing_hero",
    });
    expect(parseStartPayload("pw1_landing_miniapp_home")).toEqual({ kind: "none" });
    expect(parseStartPayload("pw1_landing_arbitrary")).toEqual({ kind: "none" });
  });

  it("returns sample for the sample keyword (case-insensitive) only", () => {
    expect(parseStartPayload("sample")).toEqual({ kind: "sample" });
    expect(parseStartPayload("SAMPLE")).toEqual({ kind: "sample" });
    expect(parseStartPayload("sampleX")).toEqual({ kind: "none" });
    expect(parseStartPayload("sample_")).toEqual({ kind: "none" });
  });

  it("translates sub_<types>_<targets> into subscribe args", () => {
    expect(parseStartPayload("sub_dews-depeg_usd-top25")).toEqual({
      kind: "subscribe",
      args: "dews depeg usd-top25",
    });
    expect(parseStartPayload("sub_dews_USDC")).toEqual({
      kind: "subscribe",
      args: "dews usdc",
    });
  });

  it("returns status/why/coverage payloads with their coin id", () => {
    expect(parseStartPayload("status_usdc-circle")).toEqual({
      kind: "status",
      coinId: "usdc-circle",
    });
    expect(parseStartPayload("why_dai-makerdao")).toEqual({
      kind: "why",
      coinId: "dai-makerdao",
    });
    expect(parseStartPayload("coverage_usdt-tether")).toEqual({
      kind: "coverage",
      coinId: "usdt-tether",
    });
  });

  it("rejects payloads with disallowed characters", () => {
    expect(parseStartPayload("status_usdc circle")).toEqual({ kind: "none" });
    expect(parseStartPayload("status_usdc.circle")).toEqual({ kind: "none" });
    expect(parseStartPayload("status_usdc/circle")).toEqual({ kind: "none" });
  });

  it("rejects payloads longer than 64 characters", () => {
    const long = `status_${"a".repeat(60)}`;
    expect(parseStartPayload(long)).toEqual({ kind: "none" });
  });

  it("returns none for unknown prefixes or malformed sub payloads", () => {
    expect(parseStartPayload("foo_bar")).toEqual({ kind: "none" });
    expect(parseStartPayload("sub_dews")).toEqual({ kind: "none" });
    expect(parseStartPayload("sub__usd-top25")).toEqual({ kind: "none" });
    expect(parseStartPayload("status_")).toEqual({ kind: "none" });
  });
});

describe("parsePendingDisambiguation", () => {
  it("falls back to legacy alert types when action_payload is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = parsePendingDisambiguation(
      makePendingRow({
        action_payload: "{bad-json",
        alert_types: JSON.stringify(["safety"]),
      }),
    );

    expect(parsed).toMatchObject({
      actionType: "subscribe",
      ambiguousTicker: "USDF",
      remainingTickers: ["USDC"],
    });
    expect(parsed?.actionType === "subscribe" && [...parsed.alertTypes]).toEqual(["safety"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=action_payload"));
  });

  it("preserves valid pending state when resolved_ids is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = parsePendingDisambiguation(
      makePendingRow({
        resolved_ids: "{bad-json",
      }),
    );

    expect(parsed).toMatchObject({
      actionType: "subscribe",
      ambiguousTicker: "USDF",
      remainingTickers: ["USDC"],
      resolvedCoins: [],
    });
    if (
      parsed
      && parsed.actionType !== "setup-step"
      && parsed.actionType !== "confirm-bulk"
      && parsed.actionType !== "forget-confirm"
    ) {
      expect(parsed.candidates).toHaveLength(2);
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=resolved_ids"));
  });

  it("preserves preset ids from the stored action payload", () => {
    const parsed = parsePendingDisambiguation(
      makePendingRow({
        action_payload: JSON.stringify({ alertTypes: ["dews"], presetIds: ["usd-top25"] }),
      }),
    );

    expect(parsed).toMatchObject({
      actionType: "subscribe",
      presetIds: ["usd-top25"],
      initiatorUserId: "999",
    });
  });

  it("returns null when candidates are malformed because selection cannot continue", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = parsePendingDisambiguation(
      makePendingRow({
        candidates: "{bad-json",
      }),
    );

    expect(parsed).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=candidates"));
  });

  it("parses a confirm-bulk subscribe payload with empty candidates", () => {
    const parsed = parsePendingDisambiguation(
      makePendingRow({
        action_type: "confirm-bulk",
        action_payload: JSON.stringify({
          kind: "subscribe",
          alertTypes: ["dews"],
          presetIds: ["usd-top25"],
          depegWorseningBpsStep: 250,
          coinIds: ["usdt-tether", "usdc-circle"],
          subscribeAll: false,
        }),
        candidates: JSON.stringify([]),
        ambiguous_ticker: "",
      }),
    );

    expect(parsed).toEqual({
      actionType: "confirm-bulk",
      payload: {
        kind: "subscribe",
        alertTypes: ["dews"],
        presetIds: ["usd-top25"],
        depegWorseningBpsStep: 250,
        coinIds: ["usdt-tether", "usdc-circle"],
        subscribeAll: false,
      },
      initiatorUserId: "999",
    });
  });

  it("returns null when a confirm-bulk payload has an unknown kind", () => {
    const parsed = parsePendingDisambiguation(
      makePendingRow({
        action_type: "confirm-bulk",
        action_payload: JSON.stringify({ kind: "bogus" }),
        candidates: JSON.stringify([]),
        ambiguous_ticker: "",
      }),
    );

    expect(parsed).toBeNull();
  });

  it("returns the setup-step sentinel instead of null for setup-wizard rows", () => {
    const parsed = parsePendingDisambiguation(
      makePendingRow({
        action_type: "setup-step",
        action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
        candidates: JSON.stringify([]),
        ambiguous_ticker: "",
      }),
    );

    expect(parsed).toEqual({ actionType: "setup-step" });
  });
});
