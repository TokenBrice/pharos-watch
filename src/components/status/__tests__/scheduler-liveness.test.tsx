import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SchedulerLivenessCard } from "../scheduler-liveness";

describe("scheduled delivery card", () => {
  it("never labels missing observation healthy", () => {
    const html = renderToStaticMarkup(<SchedulerLivenessCard observation={undefined} />);
    expect(html).toContain("unavailable");
    expect(html).toContain("Observation not supplied");
    expect(html).not.toContain("reset");
  });
  it("shows clocks, budgets and unknown lane identities without inventing a label", () => {
    const html = renderToStaticMarkup(<SchedulerLivenessCard observation={{
      status: "stale", observedAt: 2000, lastAnyStartedAt: 1999, lastFiveMinuteStartedAt: 700,
      ageSeconds: 1300, warningAfterSec: 600, staleAfterSec: 1200, unavailableReason: null,
      lanes: [{ scheduleKey: "futureLane", lastStartedAt: null }],
    }} />);
    expect(html).toContain("futureLane");
    expect(html).toContain("No start evidence");
    expect(html).toContain("600s");
    expect(html).toContain("1200s");
    expect(html).toContain("cron-delivery-stall.md");
  });
});
