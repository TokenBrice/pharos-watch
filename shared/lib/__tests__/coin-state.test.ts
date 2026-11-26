import { describe, expect, it } from "vitest";
import { noticeAppliesToScope, resolveCoinState, resolveCoinStates, type CoinStateNotice } from "../coin-state";

const NOW = Date.parse("2026-11-17T12:00:00Z") / 1000;
const danger: CoinStateNotice = { type: "danger", title: "Chain halted", kind: "paused" };
const deadline = (date: string, type: CoinStateNotice["type"] = "warning", title = "Migration closes"): CoinStateNotice => ({ type, title, kind: "deadline", deadline: date });

describe("resolveCoinStates", () => {
  it("orders every applicable state by the shared precedence ladder", () => {
    const states = resolveCoinStates({
      status: "frozen", notices: [deadline("2026-11-26"), { type: "warning", title: "Deposits disabled", kind: "paused" }, danger],
      activeDepeg: true, deviationBps: -4513, ddrTier: "recovery_unlikely", dewsBand: "ALERT", nowSec: NOW,
    });
    expect(states.map((state) => state.kind)).toEqual(["frozen", "critical", "depeg", "paused", "dews", "deadline"]);
    expect(states[1]).toMatchObject({ notice: danger });
    expect(states[2]).toMatchObject({ deviationBps: -4513, ddrTier: "recovery_unlikely" });
  });

  // Calm or absent inputs, history, out-of-window deadlines, deadlines without a clock.
  it.each([
    {}, { status: "active", activeDepeg: false, dewsBand: "WATCH" }, { dewsBand: "unknown" },
    { notices: [{ type: "danger", title: "2022 exploit", kind: "history" }] },
    { notices: [deadline("2027-01-31")], nowSec: NOW }, { notices: [deadline("2026-07-15")], nowSec: NOW },
    { notices: [deadline("2026-07-15", "danger")], nowSec: NOW }, { notices: [deadline("2027-03-01", "danger")] },
    { notices: [deadline("2026-11-26")] },
  ] as const)("claims no state from %o", (inputs) => {
    expect(resolveCoinStates(inputs)).toEqual([]);
  });

  it.each([["2026-11-26", 9], ["2026-11-17", 0], ["2026-10-31", -17]])("shows a deadline on %s inside its window (%i days)", (date, days) => {
    expect(resolveCoinState({ notices: [deadline(date)], nowSec: NOW })).toMatchObject({ kind: "deadline", daysToDeadline: days });
  });

  it("raises danger notices, paused or ahead, as critical", () => {
    expect(resolveCoinState({ notices: [danger] })).toEqual({ kind: "critical", notice: danger });
    expect(resolveCoinState({ notices: [deadline("2027-03-01", "danger")], nowSec: NOW })).toMatchObject({ kind: "critical" });
  });

  it("leads with the earliest deadline in the window, authored order on ties", () => {
    const notices = [deadline("2026-12-10", "warning", "Late"), deadline("2026-11-20", "info", "Early"), deadline("2026-11-20", "warning", "Early tie")];
    expect(resolveCoinState({ notices, nowSec: NOW })).toMatchObject({ kind: "deadline", notice: { title: "Early" }, daysToDeadline: 3 });
  });

  it.each([
    ["an upcoming deadline over a nearer passed one", ["2026-11-15", "2026-12-10"], "2026-12-10", 23],
    ["the most recently passed when every deadline has passed", ["2026-10-25", "2026-11-10"], "2026-11-10", -7],
  ] as const)("leads with %s", (_label, dates, lead, days) => {
    expect(resolveCoinState({ notices: dates.map((date) => deadline(date)), nowSec: NOW }))
      .toMatchObject({ kind: "deadline", notice: { deadline: lead }, daysToDeadline: days });
  });

  it("keeps a paused notice with a passed closing date paused, never spent", () => {
    const paused: CoinStateNotice = { type: "warning", title: "Redemptions paused", kind: "paused", deadline: "2026-01-01" };
    expect(resolveCoinStates({ notices: [paused], nowSec: NOW })).toEqual([{ kind: "paused", notice: paused }]);
  });

  // A chain-scoped notice applies only on its chains' pages; asset-wide reads skip it.
  it.each([[undefined, []], [null, []], ["ethereum", []], ["noble", ["deadline"]]] as const)("scopes chain notices to chainId %s", (chainId, kinds) => {
    const scoped = { ...deadline("2026-11-26"), chains: ["noble"] };
    expect(resolveCoinStates({ notices: [scoped], nowSec: NOW, chainId }).map((state) => state.kind)).toEqual(kinds);
    expect(noticeAppliesToScope({}, chainId)).toBe(true);
  });
});
