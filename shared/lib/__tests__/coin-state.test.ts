import { describe, expect, it } from "vitest";
import { resolveCoinState, resolveCoinStates, type CoinStateNotice } from "../coin-state";

const NOW = Date.parse("2026-11-17T12:00:00Z") / 1000;
const danger: CoinStateNotice = { type: "danger", title: "Chain halted", kind: "paused" };
const deadline = (date: string, type: CoinStateNotice["type"] = "warning"): CoinStateNotice => ({ type, title: "Migration closes", kind: "deadline", deadline: date });

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
});
