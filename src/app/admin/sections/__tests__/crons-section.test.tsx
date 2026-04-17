// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusResponse } from "@shared/types";

afterEach(() => {
  cleanup();
});

vi.mock("@/components/status/cron-card", () => ({
  CronCard: ({ job }: { job: string }) => <div data-testid={`cron-${job}`}>{job}</div>,
}));

import { CronsSection, type CronGroup } from "@/app/admin/sections/crons-section";
import { degraded, makeHealthyStatusResponse } from "@/app/admin/__tests__/fixtures/status-response";

function makeCronStatus(overrides: Partial<StatusResponse["crons"][string]> = {}): StatusResponse["crons"][string] {
  return {
    lastRun: { startedAt: 1_699_999_940, durationMs: 200, status: "ok" },
    recentRuns: [{ startedAt: 1_699_999_940, durationMs: 200, status: "ok" }],
    expectedIntervalSec: 60,
    healthy: true,
    ...overrides,
  };
}

describe("CronsSection", () => {
  it("renders the healthy summary and the empty-active placeholder when no active groups exist", () => {
    const data = makeHealthyStatusResponse();

    render(
      <CronsSection
        data={data}
        runningCrons={0}
        activeCronGroups={[]}
        healthyCronGroups={[
          {
            key: "delivery",
            title: "Delivery",
            badge: "1 job",
            description: "Dispatch and downstream delivery jobs.",
            entries: [["dispatch-telegram-alerts", makeCronStatus()]],
          },
        ]}
        isHealthyCronGroupsOpen={false}
        setIsHealthyCronGroupsOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Worker job lanes")).toBeTruthy();
    expect(screen.getByText("No unhealthy cron lanes. Healthy groups are collapsed below.")).toBeTruthy();
    expect(screen.getByText("Healthy lanes (1)")).toBeTruthy();
    // Healthy details is collapsed — cron card is still rendered inside <details>,
    // but the details element should not have the `open` attribute.
    const details = screen.getByText("Healthy lanes (1)").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("renders active cron groups and reflects unhealthy summary counts", () => {
    const impactedCron = makeCronStatus({
      healthy: false,
      lastRun: { startedAt: 1_699_999_900, durationMs: 400, status: "error", error: "timeout" },
      recentRuns: [
        { startedAt: 1_699_999_900, durationMs: 400, status: "error" },
        { startedAt: 1_699_999_800, durationMs: 400, status: "error" },
      ],
    });
    const data = degraded(makeHealthyStatusResponse(), {
      availabilityStatus: "degraded",
      summary: {
        ...makeHealthyStatusResponse().summary,
        unhealthyCrons: 1,
        availabilityImpactingUnhealthyCrons: 1,
        degradedCrons: 1,
        cronErrors: 2,
      },
      crons: {
        "dispatch-telegram-alerts": impactedCron,
      },
    });
    const activeGroup: CronGroup = {
      key: "delivery",
      title: "Delivery",
      badge: "1 job",
      description: "Dispatch lane is erroring.",
      entries: [["dispatch-telegram-alerts", impactedCron]],
    };

    render(
      <CronsSection
        data={data}
        runningCrons={1}
        activeCronGroups={[activeGroup]}
        healthyCronGroups={[]}
        isHealthyCronGroupsOpen={false}
        setIsHealthyCronGroupsOpen={vi.fn()}
      />,
    );

    // Active group card renders its title/description and the mocked CronCard child
    expect(screen.getByText("Delivery")).toBeTruthy();
    expect(screen.getByText("Dispatch lane is erroring.")).toBeTruthy();
    expect(screen.getByTestId("cron-dispatch-telegram-alerts")).toBeTruthy();
    // Summary badges reflect the degraded counts
    const impactingBadge = screen.getByText("Impacting").parentElement;
    expect(impactingBadge?.textContent).toContain("1");
    const runningBadge = screen.getByText("Running").parentElement;
    expect(runningBadge?.textContent).toContain("1");
    // No healthy-groups details when healthyCronGroups is empty
    expect(screen.queryByText(/Healthy lanes/)).toBeNull();
  });

  it("opens the healthy-groups details when isHealthyCronGroupsOpen is true", () => {
    const data = makeHealthyStatusResponse();
    const healthyGroup: CronGroup = {
      key: "pricing",
      title: "Pricing",
      badge: "2 jobs",
      description: "Price sync lanes.",
      entries: [
        ["sync-stablecoins", makeCronStatus()],
        ["sync-prices", makeCronStatus()],
      ],
    };

    render(
      <CronsSection
        data={data}
        runningCrons={0}
        activeCronGroups={[]}
        healthyCronGroups={[healthyGroup]}
        isHealthyCronGroupsOpen={true}
        setIsHealthyCronGroupsOpen={vi.fn()}
      />,
    );

    const details = screen.getByText("Healthy lanes (1)").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("cron-sync-stablecoins")).toBeTruthy();
    expect(screen.getByTestId("cron-sync-prices")).toBeTruthy();
  });
});
