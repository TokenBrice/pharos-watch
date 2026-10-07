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
      heavy: { scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: 1000, ageSeconds: 1000,
        warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null },
    }} />);
    expect(html).toContain("futureLane");
    expect(html).toContain("No start evidence");
    expect(html).toContain("600s");
    expect(html).toContain("1200s");
    expect(html).toContain("cron-delivery-stall.md");
    expect(html).toContain("Heavy Worker delivery");
    expect(html).toContain("v9SupplyAttributionOffset");
    expect(html).toContain("1800s");
    expect(html).toContain("2700s");
  });
  it("shows heavy unavailability separately from healthy public delivery", () => {
    const html = renderToStaticMarkup(<SchedulerLivenessCard observation={{
      status: "healthy", observedAt: 2000, lastAnyStartedAt: 1999, lastFiveMinuteStartedAt: 1999,
      ageSeconds: 1, warningAfterSec: 600, staleAfterSec: 1200, unavailableReason: null, lanes: [],
      heavy: { scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: null, ageSeconds: null,
        warningAfterSec: 1800, staleAfterSec: 2700, status: "unavailable", unavailableReason: "heavy-slot-start-evidence-missing" },
    }} />);
    expect(html).toContain("heavy-slot-start-evidence-missing");
    expect(html).toContain("healthy");
    expect(html).toContain("unavailable");
    expect(html).toContain("No start evidence");
  });
});
