import { describe, expect, it } from "vitest";
import { maximumBusinessDaySettlement, walkBusinessDaySettlement, BUSINESS_CALENDAR_BOUND_POLICY } from "../business-calendars";
import { REVIEWED_BUSINESS_CALENDARS } from "../../data/business-calendars/reviewed";
import type { ReviewedBusinessCalendar } from "../../types/business-calendars";
import { RedemptionBusinessDayTermsSchema, type RedemptionBusinessDayTerms } from "../../types/redemption";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";
import { resolveReviewedRedemptionSettlementDelay } from "../redemption-backstop-configs/settlement";
import { getRedemptionBackstopConfig } from "../redemption-backstops";

const clock = Date.parse("2026-10-05T12:00:00Z") / 1000;
const terms: RedemptionBusinessDayTerms = {
  businessDays: 1, calendarId: "us-federal-reserve", cutoff: { time: "16:00", timezone: "UTC" },
  assurance: "binding-guarantee", conditional: false, conditions: [], startEvent: "Accepted eligible submission",
};
const calendar: ReviewedBusinessCalendar = {
  ...REVIEWED_BUSINESS_CALENDARS["us-federal-reserve"], timezone: "UTC", holidays: [],
};

describe("reviewed business-day completion bounds", () => {
  it("walks both Christmas and New Year clusters inside the same interval", () => {
    const reviewed = { ...calendar, holidays: ["2026-12-24", "2026-12-25", "2027-01-01"] };
    const result = maximumBusinessDaySettlement({ ...terms, businessDays: 10 }, clock,
      { from: "2026-12-18", to: "2026-12-18" }, reviewed);
    expect(result).toMatchObject({ state: "known", completionDate: "2027-01-07", maximumElapsedSec: 20 * 86400 + 8 * 3600 });
    // Removing only New Year shortens the same walk; the clusters cannot be maximized independently.
    expect(maximumBusinessDaySettlement({ ...terms, businessDays: 10 }, clock,
      { from: "2026-12-18", to: "2026-12-18" }, { ...reviewed, holidays: reviewed.holidays.slice(0, 2) })).toMatchObject({ completionDate: "2027-01-06" });
  });
  it("distinguishes requests before, at, and just after cutoff", () => {
    const before = walkBusinessDaySettlement(terms, Date.parse("2026-10-09T15:59:59Z") / 1000, clock, calendar);
    const at = walkBusinessDaySettlement(terms, Date.parse("2026-10-09T16:00:00Z") / 1000, clock, calendar);
    const after = walkBusinessDaySettlement(terms, Date.parse("2026-10-09T16:00:01Z") / 1000, clock, calendar);
    expect(before).toMatchObject({ state: "known", completionDate: "2026-10-12" });
    expect(at).toMatchObject({ state: "known", completionDate: "2026-10-13" });
    expect(after).toMatchObject({ state: "known", completionDate: "2026-10-13" });
    const maximum = maximumBusinessDaySettlement(terms, clock, { from: "2026-10-09", to: "2026-10-09" }, calendar);
    expect(maximum).toMatchObject({ state: "known", maximumElapsedSec: 4 * 86400 + 8 * 3600 });
  });
  it("accounts for weekend/holiday adjacency and closed-day submissions", () => {
    const reviewed = { ...calendar, holidays: ["2026-10-12"] };
    expect(walkBusinessDaySettlement(terms, Date.parse("2026-10-09T16:00:01Z") / 1000, clock, reviewed)).toMatchObject({ completionDate: "2026-10-14" });
    expect(walkBusinessDaySettlement(terms, Date.parse("2026-10-10T00:00:00Z") / 1000, clock, reviewed)).toMatchObject({ completionDate: "2026-10-14", maximumElapsedSec: 5 * 86400 });
  });
  it("fails the entire bound when any submission walk crosses reviewed coverage", () => {
    const reviewed = { ...calendar, coverage: { from: "2026-10-01", to: "2026-10-13" } };
    expect(maximumBusinessDaySettlement(terms, clock, { from: "2026-10-09", to: "2026-10-12" }, reviewed)).toEqual({ state: "unknown", reason: "coverage-exceeded" });
    expect(maximumBusinessDaySettlement(terms, clock, undefined, reviewed)).toEqual({ state: "unknown", reason: "coverage-exceeded" });
    expect(walkBusinessDaySettlement(terms, Date.parse("2026-09-30T10:00:00Z") / 1000, clock, reviewed)).toEqual({ state: "unknown", reason: "coverage-exceeded" });
    // End-of-day completion on the last covered day itself is allowed.
    expect(walkBusinessDaySettlement(terms, Date.parse("2026-10-12T10:00:00Z") / 1000, clock, reviewed)).toMatchObject({ state: "known", completionDate: "2026-10-13" });
  });
  it("uses jurisdiction-specific weekends rather than assuming Saturday/Sunday", () => {
    const submitted = Date.parse("2026-10-11T12:00:00Z") / 1000;
    expect(walkBusinessDaySettlement({ ...terms, businessDays: 0 }, submitted, clock, { ...calendar, weekendDays: [5, 6] })).toMatchObject({ completionDate: "2026-10-11" });
    expect(walkBusinessDaySettlement({ ...terms, businessDays: 0 }, submitted, clock, calendar)).toMatchObject({ completionDate: "2026-10-12" });
  });
  it("computes elapsed UTC seconds across a DST fall-back, not days times 86400", () => {
    const local = { ...terms, cutoff: { time: "16:00", timezone: "America/New_York" } };
    expect(maximumBusinessDaySettlement(local, clock, { from: "2026-10-30", to: "2026-10-30" },
      { ...calendar, timezone: "America/New_York" })).toMatchObject({ state: "known", maximumElapsedSec: 4 * 86400 + 9 * 3600 });
    expect(maximumBusinessDaySettlement({ ...local, cutoff: { ...local.cutoff, time: "01:30" } }, clock,
      { from: "2026-11-01", to: "2026-11-01" }, { ...calendar, timezone: "America/New_York" })).toEqual({ state: "unknown", reason: "timezone-transition-unresolved" });
  });
  it("uses Federal Reserve Bank holidays, not Board employee Friday holidays", () => {
    const local = { ...terms, businessDays: 0, cutoff: { time: "16:00", timezone: "America/New_York" } };
    const julyClock = Date.parse("2026-07-01T12:00:00Z") / 1000;
    const reviewed = { ...REVIEWED_BUSINESS_CALENDARS["us-federal-reserve"], reviewedAt: "2026-07-01" };
    expect(walkBusinessDaySettlement(local, Date.parse("2026-07-03T14:00:00Z") / 1000, julyClock, reviewed)).toMatchObject({ completionDate: "2026-07-03" });
  });
  it("does not extrapolate review age, future reviews, timezone identity or unknown cutoffs", () => {
    expect(maximumBusinessDaySettlement(terms, clock + BUSINESS_CALENDAR_BOUND_POLICY.reviewedMaxAgeSec + 1, undefined, calendar)).toEqual({ state: "unknown", reason: "calendar-review-stale" });
    expect(maximumBusinessDaySettlement(terms, clock, undefined, { ...calendar, reviewedAt: "2026-10-06" })).toEqual({ state: "unknown", reason: "calendar-review-future" });
    expect(maximumBusinessDaySettlement(terms, clock)).toEqual({ state: "unknown", reason: "calendar-mismatch" });
    expect(maximumBusinessDaySettlement({ ...terms, cutoff: { ...terms.cutoff, time: null } }, clock, undefined, calendar)).toEqual({ state: "unknown", reason: "cutoff-unreviewed" });
  });
  it("keeps conditional guarantees and unconditional targets unknown", () => {
    expect(maximumBusinessDaySettlement({ ...terms, conditional: true, conditions: ["Bank/liquidation constraints"] }, clock, undefined, calendar)).toEqual({ state: "unknown", reason: "conditional-terms" });
    expect(maximumBusinessDaySettlement({ ...terms, assurance: "target" }, clock, undefined, calendar)).toEqual({ state: "unknown", reason: "target-not-guarantee" });
    expect(RedemptionBusinessDayTermsSchema.safeParse({ ...terms, conditions: ["Gate"] }).success).toBe(false);
    expect(RedemptionBusinessDayTermsSchema.safeParse({ ...terms, stages: [{ name: "realisation", businessDays: 2 }] }).success).toBe(false);
  });
  it.each(["euri-banking-circle", "brlv-crown", "fusd-finchain", "mre7yield-midas", "mmev-midas", "mhyper-midas"])("does not turn reviewed %s normal terms into an unconditional scalar", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, clock)).toBeUndefined();
    expect(RedemptionBackstopConfigSchema.safeParse({ ...config, v9RouteReviewTerms: { ...config.v9RouteReviewTerms, settlementDelaySec: 3 * 86400 } }).success).toBe(false);
  });
});
