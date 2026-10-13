import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SchedulerLivenessCard } from "../scheduler-liveness";

describe("scheduled delivery card", () => {
  it("never labels missing observation healthy", () => {
    const html = renderToStaticMarkup(<SchedulerLivenessCard observation={undefined} />);
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Healthy");
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
    expect(html).toContain("Delayed after 10m, degraded after 20m, outage after 40m.");
    // 1300s against a 1200s degraded band grades Degraded, not a raw "Stale".
    expect(html).toContain("Degraded");
    expect(html).not.toContain("Stale");
    expect(html).toContain("cron-delivery-stall.md");
    // Internal schedule keys stay reachable on hover, never as the visible label.
    expect(html).toContain("Background computation lane");
    expect(html).toContain('title="v9SupplyAttributionOffset"');
    expect(html).toContain("Delayed after 30m, degraded after 45m, outage after 1h 30m.");
  });
  it("grades an age past twice the degraded band as an outage", () => {
    const html = renderToStaticMarkup(<SchedulerLivenessCard observation={{
      status: "stale", observedAt: 5000, lastAnyStartedAt: 2500, lastFiveMinuteStartedAt: 2500,
      ageSeconds: 2500, warningAfterSec: 600, staleAfterSec: 1200, unavailableReason: null, lanes: [],
      heavy: { scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: 4000, ageSeconds: 1000,
        warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null },
    }} />);
    expect(html).toContain("Outage");
  });
  it("shows heavy unavailability separately from healthy public delivery", () => {
    const html = renderToStaticMarkup(<SchedulerLivenessCard observation={{
      status: "healthy", observedAt: 2000, lastAnyStartedAt: 1999, lastFiveMinuteStartedAt: 1999,
      ageSeconds: 1, warningAfterSec: 600, staleAfterSec: 1200, unavailableReason: null, lanes: [],
      heavy: { scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: null, ageSeconds: null,
        warningAfterSec: 1800, staleAfterSec: 2700, status: "unavailable", unavailableReason: "heavy-slot-start-evidence-missing" },
    }} />);
    expect(html).toContain("heavy-slot-start-evidence-missing");
    expect(html).toContain("Operational");
    expect(html).toContain("Unavailable");
    expect(html).toContain("No start evidence");
  });
});
