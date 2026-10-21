import { describe, expect, it } from "vitest";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import { manageAlertsMarkup } from "../rollup-step";
import type { StoredTelegramChange } from "../change-log";
import {
  computeNetRollupChanges,
  formatRollupMessage,
  isMaterialGlobalSafetyChange,
  rollupDueLocalDate,
  type RollupChatSchedule,
} from "../rollup-content";

const at = (iso: string) => Date.parse(iso) / 1000;
const schedule = (extra: Partial<RollupChatSchedule> = {}): RollupChatSchedule => ({
  timezone: null, quietHoursEnabled: false, quietHoursStart: null, quietHoursEnd: null, lastRollupLocalDate: null, ...extra,
});

let nextId = 1;
function safety(coin: string, from: string, to: string, observedAt = 100): StoredTelegramChange {
  return { id: nextId++, kind: "safety", stablecoinId: coin, sourceKey: `s${nextId}`, observedAt, payload: { symbol: coin.toUpperCase(), from, to, fromScore: null, toScore: null } };
}
function dews(coin: string, from: string, to: string, score = 40): StoredTelegramChange {
  return { id: nextId++, kind: "dews", stablecoinId: coin, sourceKey: `d${nextId}`, observedAt: 100, payload: { symbol: coin.toUpperCase(), from, to, score } };
}
function freeze(coin: string, amount: number | null): StoredTelegramChange {
  return {
    id: nextId++, kind: "freeze", stablecoinId: coin, sourceKey: `f${nextId}`, observedAt: 100,
    payload: { symbol: coin.toUpperCase(), eventType: "blacklist", chainName: "Ethereum", amountUsdAtEvent: amount, tapeEventId: `t${nextId}` },
  };
}

describe("rollupDueLocalDate", () => {
  it("is due from 09:00 UTC when no timezone is set, once per date", () => {
    expect(rollupDueLocalDate(schedule(), at("2026-10-21T08:59:00Z"))).toBeNull();
    expect(rollupDueLocalDate(schedule(), at("2026-10-21T09:00:00Z"))).toBe("2026-10-21");
    expect(rollupDueLocalDate(schedule(), at("2026-10-21T17:00:00Z"))).toBe("2026-10-21");
    expect(rollupDueLocalDate(schedule({ lastRollupLocalDate: "2026-10-21" }), at("2026-10-21T17:00:00Z"))).toBeNull();
    expect(rollupDueLocalDate(schedule({ lastRollupLocalDate: "2026-10-21" }), at("2026-10-22T09:00:00Z"))).toBe("2026-10-22");
  });

  it("follows the chat timezone across daylight-saving changes", () => {
    const ny = schedule({ timezone: "America/New_York" });
    // Summer (EDT, UTC-4): 09:00 local is 13:00 UTC.
    expect(rollupDueLocalDate(ny, at("2026-07-01T12:59:00Z"))).toBeNull();
    expect(rollupDueLocalDate(ny, at("2026-07-01T13:00:00Z"))).toBe("2026-07-01");
    // Winter (EST, UTC-5): 09:00 local is 14:00 UTC.
    expect(rollupDueLocalDate(ny, at("2026-12-01T13:30:00Z"))).toBeNull();
    expect(rollupDueLocalDate(ny, at("2026-12-01T14:00:00Z"))).toBe("2026-12-01");
    // Spring-forward day (2026-03-08): 09:00 EDT is 13:00 UTC.
    expect(rollupDueLocalDate(ny, at("2026-03-08T12:59:00Z"))).toBeNull();
    expect(rollupDueLocalDate(ny, at("2026-03-08T13:00:00Z"))).toBe("2026-03-08");
    // Fall-back day (2026-11-01): 09:00 EST is 14:00 UTC.
    expect(rollupDueLocalDate(ny, at("2026-11-01T13:59:00Z"))).toBeNull();
    expect(rollupDueLocalDate(ny, at("2026-11-01T14:00:00Z"))).toBe("2026-11-01");
    // Local date, not UTC date: 01:00 UTC on Oct 22 is still Oct 21 in New York.
    expect(rollupDueLocalDate(ny, at("2026-10-22T01:00:00Z"))).toBe("2026-10-21");
  });

  it("handles half-hour zones and falls back to UTC for an unknown zone", () => {
    expect(rollupDueLocalDate(schedule({ timezone: "Asia/Kolkata" }), at("2026-10-21T03:29:00Z"))).toBeNull();
    expect(rollupDueLocalDate(schedule({ timezone: "Asia/Kolkata" }), at("2026-10-21T03:30:00Z"))).toBe("2026-10-21");
    expect(rollupDueLocalDate(schedule({ timezone: "Mars/Olympus" }), at("2026-10-21T09:00:00Z"))).toBe("2026-10-21");
    // Quiet hours use the same validated (UTC) zone as the due hour.
    const quietUnknown = schedule({ timezone: "Mars/Olympus", quietHoursEnabled: true, quietHoursStart: 8, quietHoursEnd: 10 });
    expect(rollupDueLocalDate(quietUnknown, at("2026-10-21T09:30:00Z"))).toBeNull();
    expect(rollupDueLocalDate(quietUnknown, at("2026-10-21T10:00:00Z"))).toBe("2026-10-21");
  });

  it("defers to the end of quiet hours instead of sending inside them", () => {
    const quiet = schedule({ timezone: "Europe/Paris", quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 10 });
    // 09:00 Paris (CEST, UTC+2) is quiet; 10:00 is the first due instant.
    expect(rollupDueLocalDate(quiet, at("2026-07-01T07:00:00Z"))).toBeNull();
    expect(rollupDueLocalDate(quiet, at("2026-07-01T08:00:00Z"))).toBe("2026-07-01");
  });
});

describe("computeNetRollupChanges", () => {
  it("cancels flaps that end where they started", () => {
    expect(computeNetRollupChanges([
      safety("usdx", "B", "C"), safety("usdx", "C", "B"),
      dews("usdy", "WARNING", "WATCH"), dews("usdy", "WATCH", "WARNING"),
    ])).toEqual([]);
  });

  it("nets a chain of moves to its first and last state", () => {
    expect(computeNetRollupChanges([safety("usdx", "B", "B-"), safety("usdx", "B-", "C+"), safety("usdx", "C+", "C")]))
      .toEqual([{ kind: "safety", stablecoinId: "usdx", symbol: "USDX", from: "B", to: "C", fromScore: null, toScore: null }]);
  });

  it("counts freezes per coin with known and unpriced amounts, and ignores overflow rows", () => {
    expect(computeNetRollupChanges([
      freeze("usdc", 1_000), freeze("usdc", null), freeze("usdc", 2_500),
      { id: 99, kind: "overflow", chatId: "1", sourceKey: "o", observedAt: 100, payload: { families: ["safety"], coinIds: [] } },
    ])).toEqual([{ kind: "freeze", stablecoinId: "usdc", symbol: "USDC", count: 3, knownUsd: 3_500, unpriced: 1 }]);
  });
});

describe("formatRollupMessage", () => {
  it("is null when there is nothing to report", () => {
    expect(formatRollupMessage({ changes: [], overflowCount: 0 })).toBeNull();
  });

  it("leads with the worst change, lists improvements last and escapes HTML", () => {
    const message = formatRollupMessage({
      changes: computeNetRollupChanges([
        safety("up", "C", "B"),
        safety("x<y", "B", "D"),
        dews("calm", "WARNING", "ALERT", 61),
        freeze("usdc", 5_000),
      ]),
      overflowCount: 2,
    })!;
    expect(message.split("\n")[0]).toBe("<b>Daily changes</b>: 4 changes on your coins, led by X&lt;Y Safety grade downgraded B → D");
    expect(message).toContain("<b>Safety grades</b>\n<b>X&lt;Y</b> Safety grade downgraded B → D\n<b>UP</b> Safety grade raised C → B");
    expect(message).toContain("<b>CALM</b> stress eased to ALERT (61/100, was WARNING)");
    expect(message).toContain("<b>USDC</b> 1 freeze event, $5,000 known");
    expect(message).toContain(`+ 2 more alerts held back by the limit of ${TELEGRAM_ALERT_POLICY.chatCap.maxRealtimeMessages} live messages a day`);
  });

  it("reports cap overflow alone, and folds lines past the list limit into N more changes", () => {
    expect(formatRollupMessage({ changes: [], overflowCount: 1 })!.split("\n")[0]).toBe("<b>Daily changes</b>: 1 alert held back");
    const many = Array.from({ length: TELEGRAM_ALERT_POLICY.rollup.maxListedChanges + 3 }, (_, index) => safety(`c${index}`, "B", "C"));
    expect(formatRollupMessage({ changes: computeNetRollupChanges(many), overflowCount: 0 })).toContain("+ 3 more changes on pharos.watch");
  });
});

describe("public reserve sample", () => {
  it("is the plain-text render of a real roll-up and its keyboard", () => {
    const html = formatRollupMessage({
      changes: computeNetRollupChanges([
        safety("pyusd-paypal", "B", "C+"),
        { id: 500, kind: "reserve", stablecoinId: "usdc-circle", sourceKey: "r", observedAt: 100, payload: { symbol: "USDC", name: "Circle USD Coin" } },
      ]).map((change) => change.kind === "safety" ? { ...change, symbol: "PYUSD" } : change),
      overflowCount: 0,
    })!;
    const plain = html
      .replace(/\n\n<a href="https:\/\/([^"]+)">View on Pharos<\/a>$/, "\n\nView on Pharos: $1")
      .replace(/<[^>]+>/g, "")
      .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
    expect(TELEGRAM_PUBLIC_ALERT_SAMPLES.reserve.message).toBe(plain);
    expect(TELEGRAM_PUBLIC_ALERT_SAMPLES.reserve.buttons)
      .toEqual(manageAlertsMarkup("1").inline_keyboard.map((row) => row.map((button) => button.text)));
  });
});

describe("isMaterialGlobalSafetyChange", () => {
  const scored = (fromScore: number | null, toScore: number | null) =>
    ({ kind: "safety" as const, stablecoinId: "x", symbol: "X", from: "B", to: "B-", fromScore, toScore });
  it("needs the policy score change when both scores are known", () => {
    const drop = TELEGRAM_ALERT_POLICY.safety.globalMinScoreDrop;
    expect(isMaterialGlobalSafetyChange(scored(70, 70 - drop + 1))).toBe(false);
    expect(isMaterialGlobalSafetyChange(scored(70, 70 - drop))).toBe(true);
    expect(isMaterialGlobalSafetyChange(scored(60, 60 + drop))).toBe(true);
    expect(isMaterialGlobalSafetyChange(scored(null, 50))).toBe(true);
  });
});
