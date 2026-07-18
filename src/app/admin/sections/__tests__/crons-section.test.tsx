// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BudgetOnlySurfaceStatus, CronStatus, StatusResponse } from "@shared/types";
import { CronsSection, type CronGroup } from "@/app/admin/sections/crons-section";
import { degraded, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

afterEach(() => {
  cleanup();
});

function makeCronStatus(overrides: Partial<CronStatus> = {}): CronStatus {
  return {
    lastRun: { startedAt: 1_699_999_940, durationMs: 200, status: "ok" },
    recentRuns: [{ startedAt: 1_699_999_940, durationMs: 200, status: "ok" }],
    expectedIntervalSec: 60,
    healthy: true,
    ...overrides,
  };
}

function makeGroup(entries: CronGroup["entries"], overrides: Partial<Omit<CronGroup, "entries">> = {}): CronGroup {
  return {
    key: "quarter-hourly",
    title: "15-minute slot",
    badge: "*/15",
    description: "Shared core ingestion and status jobs.",
    entries,
    ...overrides,
  };
}

function makeData(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return degraded(makeHealthyStatusResponse(), overrides);
}

function makeBudgetSurface(overrides: Partial<BudgetOnlySurfaceStatus> = {}): BudgetOnlySurfaceStatus {
  return {
    job: "telegram-registration-reconciliation",
    label: "Telegram registration reconciliation",
    scheduleKey: "fiveMinuteTelegramAlerts",
    schedule: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    expectedIntervalSec: 300,
    maxAgeSec: 900,
    maxConnections: 1,
    connectionGroup: "five-minute-telegram-chain",
    telemetryStatus: "fresh",
    telemetryUnknown: false,
    checkedAt: 1_699_999_970,
    ageSeconds: 30,
    durationMs: 2_582_400,
    dueCount: 4,
    processedCount: 3,
    outcome: "degraded",
    skippedReason: null,
    error: null,
    metadata: { reconciled: 3 },
    ...overrides,
  };
}

function renderCrons({
  groups,
  data = makeHealthyStatusResponse(),
  runningCrons = 0,
}: {
  groups: CronGroup[];
  data?: StatusResponse;
  runningCrons?: number;
}) {
  return render(<CronsSection data={data} runningCrons={runningCrons} cronGroups={groups} />);
}

describe("CronsSection", () => {
  it("defers healthy rows by default and lets the operator mount all jobs explicitly", () => {
    renderCrons({
      groups: [
        makeGroup([["sync-stablecoins", makeCronStatus()]], {
          description: "Healthy shared ingestion.",
        }),
      ],
    });

    expect(screen.getByText("Cron Lanes")).toBeTruthy();
    expect(
      screen.getByText("No cron jobs need attention. Healthy jobs are not mounted in the default view."),
    ).toBeTruthy();
    expect(screen.queryByTestId("cron-row-sync-stablecoins")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all jobs" }));

    expect(screen.getByTestId("cron-row-sync-stablecoins")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Cron jobs by trigger group" })).toBeTruthy();
    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);
  });

  it("renders trigger-group boundaries and canonical severity ordering inside each group", () => {
    const unhealthy = makeCronStatus({ healthy: false });
    const degradedCron = makeCronStatus({
      lastRun: { startedAt: 1_699_999_900, durationMs: 400, status: "degraded" },
      recentRuns: [{ startedAt: 1_699_999_900, durationMs: 400, status: "degraded" }],
    });
    renderCrons({
      groups: [
        makeGroup([
          ["snapshot-chain-supply", unhealthy],
          ["sync-fx-rates", degradedCron],
          ["sync-stablecoins", unhealthy],
        ]),
        makeGroup([["dispatch-telegram-alerts", makeCronStatus({ healthy: false })]], {
          key: "five-minute",
          title: "5-minute slot",
          badge: "~5 min",
          description: "Dedicated delivery and recovery jobs.",
        }),
      ],
      data: makeData({
        summary: {
          ...makeHealthyStatusResponse().summary,
          unhealthyCrons: 3,
          availabilityImpactingUnhealthyCrons: 2,
          watchUnhealthyCrons: 1,
          degradedCrons: 1,
        },
      }),
    });

    expect(screen.getAllByText("15-minute slot").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5-minute slot").length).toBeGreaterThan(0);
    expect(screen.getByText(/3\/3 shown · 2 unhealthy · 1 degraded/)).toBeTruthy();
    const firstGroup = screen.getByRole("rowgroup", { name: "15-minute slot cron jobs" });
    const rowIds = within(firstGroup)
      .getAllByTestId(/^cron-row-/)
      .map((row) => row.getAttribute("data-testid"));
    expect(rowIds).toEqual(["cron-row-sync-stablecoins", "cron-row-snapshot-chain-supply", "cron-row-sync-fx-rates"]);
  });

  it("shows neutral skips that inherit a degraded required outcome in the attention view", () => {
    const neutralRun = { startedAt: 1_699_999_940, durationMs: 200, status: "skipped_neutral" as const };
    const degradedRun = { startedAt: 1_699_999_000, durationMs: 500, status: "degraded" as const };
    renderCrons({
      groups: [
        makeGroup([
          [
            "discovery-scan",
            makeCronStatus({
              lastRun: neutralRun,
              recentRuns: [neutralRun, degradedRun],
              healthy: true,
            }),
          ],
        ]),
      ],
    });

    const row = screen.getByTestId("cron-row-discovery-scan");
    expect(within(row).getByText("Degraded")).toBeTruthy();
    expect(within(row).getByText("Completed with warnings (latest required run)")).toBeTruthy();
    const warningBadge = screen
      .getAllByText("Completed with warnings")
      .find((element) => element.getAttribute("data-slot") === "badge");
    expect(warningBadge?.className).toContain("whitespace-normal");
  });

  it("labels a neutral skip after a failed required run as unhealthy", () => {
    const neutralRun = { startedAt: 1_699_999_940, durationMs: 200, status: "skipped_neutral" as const };
    const failedRun = { startedAt: 1_699_999_000, durationMs: 500, status: "error" as const };
    renderCrons({
      groups: [
        makeGroup([
          [
            "discovery-scan",
            makeCronStatus({
              lastRun: neutralRun,
              recentRuns: [neutralRun, failedRun],
              healthy: false,
            }),
          ],
        ]),
      ],
    });

    const row = screen.getByTestId("cron-row-discovery-scan");
    expect(within(row).getByText("Unhealthy")).toBeTruthy();
    expect(within(row).getByText("Failed (latest required run)")).toBeTruthy();
  });

  it("combines state, impact, trigger-group, running, and search filters", () => {
    renderCrons({
      groups: [
        makeGroup([
          ["sync-stablecoins", makeCronStatus({ healthy: false })],
          ["snapshot-chain-supply", makeCronStatus()],
        ]),
        makeGroup(
          [
            [
              "dispatch-telegram-alerts",
              makeCronStatus({ inFlight: { startedAt: 1_699_999_900, updatedAt: 1_699_999_990, stale: false } }),
            ],
          ],
          { key: "five-minute", title: "5-minute slot", badge: "~5 min" },
        ),
      ],
    });

    fireEvent.change(screen.getByLabelText("State"), { target: { value: "all" } });
    expect(screen.getByTestId("cron-row-snapshot-chain-supply")).toBeTruthy();
    expect(screen.getByTestId("cron-row-dispatch-telegram-alerts")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Impact class"), { target: { value: "public-critical" } });
    expect(screen.getByTestId("cron-row-sync-stablecoins")).toBeTruthy();
    expect(screen.queryByTestId("cron-row-dispatch-telegram-alerts")).toBeNull();

    fireEvent.change(screen.getByLabelText("Impact class"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Trigger group"), { target: { value: "five-minute" } });
    expect(screen.getByTestId("cron-row-dispatch-telegram-alerts")).toBeTruthy();
    expect(screen.queryByTestId("cron-row-sync-stablecoins")).toBeNull();

    fireEvent.change(screen.getByLabelText("Running status"), { target: { value: "running" } });
    expect(screen.getByTestId("cron-row-dispatch-telegram-alerts")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search jobs"), { target: { value: "no-match" } });
    expect(screen.getByText("No cron jobs match the current filters.")).toBeTruthy();
  });

  it("uses one row selection control and conditionally links only the selected row to detail", () => {
    renderCrons({
      groups: [
        makeGroup([
          ["sync-stablecoins", makeCronStatus({ healthy: false })],
          ["sync-fx-rates", makeCronStatus({ healthy: false })],
        ]),
      ],
    });

    const stablecoinRow = screen.getByTestId("cron-row-sync-stablecoins");
    const fxRow = screen.getByTestId("cron-row-sync-fx-rates");
    expect(stablecoinRow.getAttribute("aria-selected")).toBe("true");
    expect(stablecoinRow.getAttribute("aria-controls")).toBe("cron-selected-job-detail");
    expect(fxRow.getAttribute("aria-selected")).toBe("false");
    expect(fxRow.hasAttribute("aria-controls")).toBe(false);
    const stablecoinSelect = within(stablecoinRow).getByRole("button");
    const fxSelect = within(fxRow).getByRole("button");
    expect(stablecoinSelect.getAttribute("aria-controls")).toBe("cron-selected-job-detail");
    expect(fxSelect.hasAttribute("aria-controls")).toBe(false);
    expect(within(fxRow).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(fxSelect);

    expect(fxRow.getAttribute("aria-selected")).toBe("true");
    expect(fxRow.getAttribute("aria-controls")).toBe("cron-selected-job-detail");
    expect(fxSelect.getAttribute("aria-controls")).toBe("cron-selected-job-detail");
    expect(stablecoinRow.getAttribute("aria-selected")).toBe("false");
    expect(stablecoinSelect.hasAttribute("aria-controls")).toBe(false);
    expect(screen.getByRole("complementary", { name: "Details for FX rates" })).toBeTruthy();

    fireEvent.click(stablecoinRow);
    expect(stablecoinRow.getAttribute("aria-selected")).toBe("true");
  });

  it("shows readable outcomes, exact long durations, visible dot legend, and accessible dot labels", () => {
    const runs: CronStatus["recentRuns"] = [
      { startedAt: 1_699_999_940, durationMs: 2_582_400, status: "skipped_neutral" },
      { startedAt: 1_699_999_880, durationMs: 1_000, status: "ok" },
      { startedAt: 1_699_999_820, durationMs: 2_000, status: "degraded" },
      { startedAt: 1_699_999_760, durationMs: 3_000, status: "error" },
    ];
    renderCrons({
      groups: [
        makeGroup([
          [
            "sync-stablecoins",
            makeCronStatus({
              healthy: false,
              lastRun: runs[0]!,
              recentRuns: runs,
            }),
          ],
        ]),
      ],
    });

    expect(screen.getAllByText("Recent runs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Skipped").length).toBeGreaterThan(0);
    expect(screen.getAllByText("43m 2s").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw: skipped_neutral")).toBeTruthy();
    expect(screen.getByLabelText(/Skipped: .*raw status skipped_neutral/)).toBeTruthy();
    expect(screen.getByLabelText(/Succeeded: .*raw status ok/)).toBeTruthy();
    expect(screen.getByLabelText(/Completed with warnings: .*raw status degraded/)).toBeTruthy();
    expect(screen.getByLabelText(/Failed: .*raw status error/)).toBeTruthy();
    expect(screen.getAllByTitle(/2582\.4s \(2582400ms\)/).length).toBeGreaterThan(0);
  });

  it("surfaces running lease, stale artifacts, orphaned progress, and latest attempt evidence", () => {
    const cron = makeCronStatus({
      healthy: false,
      inFlight: {
        startedAt: 1_699_999_800,
        updatedAt: 1_699_999_900,
        stage: "price-enrichment",
        leaseOwner: "lease-owner-a",
        itemsDone: 4,
        itemsTotal: 10,
        metadata: { cursor: "coin-a" },
        stale: true,
      },
      staleArtifacts: [
        {
          kind: "expired-lease",
          job: "sync-stablecoins",
          leaseOwner: "expired-owner",
          leaseUntil: 1_699_999_000,
          slotStartedAt: 1_699_998_900,
        },
        {
          kind: "orphaned-progress",
          job: "sync-stablecoins",
          progressUpdatedAt: 1_699_998_000,
          progressStage: "reserve-fetch",
        },
      ],
      latestAttempt: {
        attemptId: "attempt-42",
        idempotencyKey: "slot:42",
        scheduleKey: "quarterHourly",
        job: "sync-stablecoins",
        slotStartedAt: 1_699_999_800,
        producerPath: "quarterHourly",
        producerKind: "scheduled-job",
        invocationId: "invocation-42",
        workerVersion: "worker-version-a",
        state: "running",
        statusClass: null,
        attemptNo: 2,
        owner: "attempt-owner-a",
        leaseUntil: 1_700_000_100,
        queuedAt: 1_699_999_700,
        claimedAt: 1_699_999_750,
        startedAt: 1_699_999_800,
        lastHeartbeatAt: 1_699_999_900,
        finishedAt: null,
        updatedAt: 1_699_999_900,
        durationMs: null,
        itemCount: null,
        stale: true,
        error: null,
      },
    });
    renderCrons({ groups: [makeGroup([["sync-stablecoins", cron]])] });

    expect(screen.getAllByText("Stale heartbeat").length).toBeGreaterThan(0);
    expect(screen.getByText("lease-owner-a")).toBeTruthy();
    expect(screen.getByText("Stale lease and progress evidence")).toBeTruthy();
    expect(screen.getByText("Expired lease")).toBeTruthy();
    expect(screen.getByText("Orphaned progress")).toBeTruthy();
    expect(screen.getByText("reserve-fetch")).toBeTruthy();
    expect(screen.getByText("Latest attempt #2")).toBeTruthy();
    expect(screen.getByText("attempt-42")).toBeTruthy();
    expect(screen.getByText("attempt-owner-a")).toBeTruthy();
    expect(screen.getByText("worker-version-a")).toBeTruthy();
    expect(screen.getByText("Full progress metadata")).toBeTruthy();
    expect(screen.getAllByText("Scheduled slot")).toHaveLength(2);
    expect(screen.getByText("Queued / claimed / started")).toBeTruthy();
  });

  it("distinguishes scoped-out attempt telemetry and unreported item counts", () => {
    renderCrons({
      groups: [
        makeGroup([
          [
            "snapshot-supply",
            makeCronStatus({
              attemptTelemetry: "scoped-out",
              lastRun: { startedAt: 1_699_999_940, durationMs: 200, status: "degraded" },
              recentRuns: [{ startedAt: 1_699_999_940, durationMs: 200, status: "degraded" }],
            }),
          ],
        ]),
      ],
    });

    expect(screen.getByText("Attempt ledger is not enabled for this job.")).toBeTruthy();
    expect(screen.getByText("Last completed")).toBeTruthy();
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
  });

  it("renders budget-only trigger groups from top-level telemetry with outcome, counts, duration, and budget", async () => {
    const data = makeData({
      budgetOnlySurfaces: [makeBudgetSurface()],
      summary: {
        ...makeHealthyStatusResponse().summary,
        budgetOnlySurfaceCount: 1,
        budgetOnlySurfaceStaleTelemetry: 0,
        budgetOnlySurfaceErrors: 0,
      },
    });
    renderCrons({ groups: [], data });

    expect(screen.getByText("Budget-only scheduled surfaces")).toBeTruthy();
    expect(screen.getByText("fiveMinuteTelegramAlerts")).toBeTruthy();
    expect(screen.getByText("Telegram registration reconciliation")).toBeTruthy();
    expect(screen.getByText("Fresh telemetry")).toBeTruthy();
    expect(screen.getAllByText("Completed with warnings").length).toBeGreaterThan(0);
    // Deep surface evidence stays unmounted until the row disclosure opens.
    expect(screen.queryByText("43m 2s")).toBeNull();
    fireEvent.click(screen.getByText("Telegram registration reconciliation"));
    expect(await screen.findByText("43m 2s")).toBeTruthy();
    expect(screen.getByText("4 / 3")).toBeTruthy();
    expect(screen.getByText("1 max")).toBeTruthy();
    expect(screen.getByText("five-minute-telegram-chain")).toBeTruthy();
    expect(screen.getByText("fresh / degraded")).toBeTruthy();
  });

  it("states Unknown explicitly when tracked and budget-only telemetry are both empty", () => {
    renderCrons({ groups: [], data: makeData({ crons: {}, budgetOnlySurfaces: [] }) });

    expect(screen.getByText("No cron job telemetry was reported. State is unknown.")).toBeTruthy();
    expect(screen.getByText("No budget-only surface telemetry was reported. State is unknown.")).toBeTruthy();
  });

  it("keeps the cron header sticky inside a locally bounded viewport", () => {
    renderCrons({ groups: [makeGroup([["sync-stablecoins", makeCronStatus({ healthy: false })]])] });

    const tableShell = screen.getByTestId("cron-lane-table");
    const viewport = tableShell.querySelector('[data-slot="table-viewport"]');
    const detail = screen.getByRole("complementary", { name: "Details for Stablecoin sync" });
    expect(tableShell.className).toContain("table-header-sticky");
    expect(tableShell.className).toContain("rounded-lg");
    expect(tableShell.className).not.toContain("rounded-xl");
    expect(detail.className).toContain("rounded-lg");
    expect(detail.className).not.toContain("rounded-xl");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.className).toContain("overflow-y-auto");
    expect(viewport?.className).toContain("max-h-[min(70vh,44rem)]");
  });
});
