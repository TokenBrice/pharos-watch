// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CronStatus, StatusResponse } from "@shared/types";
import { CronsSection, type CronGroup } from "@/app/admin/sections/crons-section";
import { degraded, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
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



function renderCrons({
  groups,
  data = makeHealthyStatusResponse(),
}: {
  groups: CronGroup[];
  data?: StatusResponse;
}) {
  return render(<CronsSection data={data} cronGroups={groups} />);
}

describe("CronsSection", () => {
  it("retains the required failure evidence behind ten neutral admissions", () => {
    const neutralRuns = Array.from({ length: 10 }, (_, index) => ({
      startedAt: 1_699_999_940 - index * 10, durationMs: 200, status: "skipped_neutral" as const,
    }));
    const failedRun = { startedAt: 1_699_999_000, durationMs: 500, status: "error" as const };
    renderCrons({ groups: [makeGroup([["snapshot-psi", makeCronStatus({
      lastRun: neutralRuns[0], recentRuns: [...neutralRuns, failedRun], expectedIntervalSec: 86_400, healthy: false,
    })]])] });
    const row = screen.getByTestId("cron-row-snapshot-psi");
    expect(within(row).getAllByRole("listitem")).toHaveLength(11);
    expect(within(row).getByLabelText(/Failed: .*raw status error/)).toBeTruthy();
    const detail = screen.getByRole("complementary", { name: /Details for/ });
    expect(within(detail).getByText("Recent runs and retained evidence")).toBeTruthy();
    expect(within(detail).getByText("Failed")).toBeTruthy();
  });

  it.each(["unknown", "errors", "empty", "success"] as const)(
    "scopes last-completed evidence for %s history",
    (history) => {
      const recentRuns = history === "success"
        ? [{ startedAt: 1_699_999_940, durationMs: 200, status: "ok" as const }]
        : history === "errors"
          ? Array.from({ length: 10 }, (_, index) => ({
            startedAt: 1_699_999_940 - index * 60, durationMs: 200, status: "error" as const,
          }))
          : [];
      renderCrons({ groups: [makeGroup([["sync-stablecoins", makeCronStatus({
        recentRuns,
        lastRun: recentRuns[0] ?? null,
        healthy: history === "unknown" ? null : false,
        telemetryUnknown: history === "unknown",
        telemetryUnknownReason: history === "unknown" ? "cron-history-read-failed" : undefined,
      })]])] });
      const row = screen.getByTestId("cron-row-sync-stablecoins");
      const detail = screen.getByRole("complementary", { name: /Details for/ });
      if (history === "unknown") {
        expect(within(detail).getByText("Last success: Unknown: cron-history-read-failed")).toBeTruthy();
        expect(within(row).getByText("Unavailable")).toBeTruthy();
      } else if (history === "success") {
        expect(within(detail).queryByText(/No successful run/)).toBeNull();
        expect(within(row).getByText("1m ago")).toBeTruthy();
      } else {
        expect(within(detail).getByText("Last success: No successful run in recent history")).toBeTruthy();
      }
    },
  );
  it.each([
    {
      name: "shows neutral skips that inherit a degraded required outcome in the attention view",
      requiredStatus: "degraded",
      healthy: true,
    },
    {
      name: "labels a neutral skip after a failed required run as unhealthy",
      requiredStatus: "error",
      healthy: false,
    },
  ] as const)("$name", ({ requiredStatus, healthy }) => {
    const neutralRun = { startedAt: 1_699_999_940, durationMs: 200, status: "skipped_neutral" as const };
    const requiredRun = { startedAt: 1_699_999_000, durationMs: 500, status: requiredStatus };
    renderCrons({
      groups: [
        makeGroup([
          [
            "weekly-recap",
            makeCronStatus({
              lastRun: neutralRun,
              recentRuns: [neutralRun, requiredRun],
              expectedIntervalSec: 900,
              healthy,
            }),
          ],
        ]),
      ],
    });

    const row = screen.getByTestId("cron-row-weekly-recap");
    expect(within(row).getByText("Watch")).toBeTruthy();
    expect(within(row).getByText("Skipped: no work required")).toBeTruthy();
    if (requiredStatus === "degraded") {
      expect(within(row).queryByText("Run warning")).toBeNull();
      expect(within(row).getByText("200ms")).toBeTruthy();
      expect(within(row).queryByText("500ms")).toBeNull();
      const warningBadge = screen
        .getAllByText("Completed with warnings")
        .find((element) => element.getAttribute("data-slot") === "badge");
      expect(warningBadge?.className).toContain("whitespace-normal");
    } else {
      expect(within(row).getByText("The latest required run failed.")).toBeTruthy();
    }
  });

  it("keeps a fresh neutral-only no-op without success evidence in the attention view as one verdict", () => {
    const neutralRun = { startedAt: 1_699_999_940, durationMs: 200, status: "skipped_neutral" as const };
    renderCrons({
      groups: [
        makeGroup([
          [
            "compute-safety-score-v9",
            makeCronStatus({
              lastRun: neutralRun,
              recentRuns: [neutralRun],
              healthy: false,
            }),
          ],
        ]),
      ],
    });

    const row = screen.getByTestId("cron-row-compute-safety-score-v9");
    expect(within(row).getByText("Watch")).toBeTruthy();
    expect(within(row).getByText("Skipped: no work required", { exact: false })).toBeTruthy();
    expect(screen.getByText("1 job · 1 watch")).toBeTruthy();
  });

  it("leads the detail panel with the reason, budget, and operator actions", () => {
    renderCrons({
      groups: [makeGroup([["sync-blacklist", makeCronStatus({ healthy: false, lastRun: null, recentRuns: [] })]])],
    });

    const detail = screen.getByRole("complementary", { name: /Details for/ });
    const why = within(detail).getByRole("region", { name: "Why this state" });
    expect(within(why).getByText(/No usable run within the 2m budget\. Public data depends on this job\./)).toBeTruthy();
    expect(within(why).getByText("no-fresh-run")).toBeTruthy();
    expect(within(why).getByText(/Expected every 1m, stale after 2m without a usable run\./)).toBeTruthy();
    const actions = within(detail).getByRole("region", { name: "Actions" });
    expect(within(actions).getByRole("link", { name: /Blacklist sync runbook/ }).getAttribute("href")).toContain("docs/runbooks/blacklist-sync.md");
    expect(within(actions).getByRole("link", { name: "View status history" }).getAttribute("href")).toMatch(/^\/admin\/history\/?$/);
    expect(within(actions).getByText("wrangler tail stablecoin-api --format pretty --search sync-blacklist")).toBeTruthy();
    expect(within(actions).getAllByRole("link").length).toBeGreaterThanOrEqual(3);
    expect(within(detail).getByText("Resource telemetry not measured on this runtime.")).toBeTruthy();
  });

  it("surfaces running lease, stale artifacts, and orphaned progress evidence", () => {
    const pressure = {
      phase: "current-intake", observedAt: 1_699_999_900, bodyCapBytes: 4096, cacheCapBytes: null,
      cacheEntryCapBytes: null, maxConcurrentDecodes: null, inputCapBytes: null, catalogMaxAssets: null,
      intakeBytes: 0, cacheBytes: null, rejectedBodies: 0, inputBytes: null, catalogAssets: null,
      intakeBasis: "actual-stream" as const, cacheBasis: "unavailable" as const, guard: "within-policy" as const,
      platformOutcome: null, platformOutcomeSource: null, heapUsedBytes: null,
      heapUnavailableReason: "workers-runtime-no-heap-api" as const,
    };
    const cron = makeCronStatus({
      healthy: false,
      lastRun: { startedAt: 1_699_999_700, durationMs: 100, status: "ok",
        metadata: { resourcePressure: { ...pressure, phase: "last-publication", observedAt: 1_699_999_700, intakeBytes: 123 } } },
      inFlight: {
        startedAt: 1_699_999_800,
        updatedAt: 1_699_999_900,
        stage: "price-enrichment",
        leaseOwner: "lease-owner-a",
        itemsDone: 4,
        itemsTotal: 10,
        metadata: { cursor: "coin-a", resourcePressure: pressure },
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
    });
    renderCrons({ groups: [makeGroup([["sync-stablecoins", cron]])] });

    expect(screen.getAllByText("Stale heartbeat").length).toBeGreaterThan(0);
    expect(screen.getByText("lease-owner-a")).toBeTruthy();
    expect(screen.getByText("Stale lease and progress evidence")).toBeTruthy();
    expect(screen.getByText("Expired lease")).toBeTruthy();
    expect(screen.getByText("Orphaned progress")).toBeTruthy();
    expect(screen.getByText("reserve-fetch")).toBeTruthy();
    expect(screen.getByText("Full progress metadata")).toBeTruthy();
    expect(screen.getAllByText("Scheduled slot")).toHaveLength(2);
    const current = screen.getByRole("region", { name: "Current progress resource evidence" });
    const terminal = screen.getByRole("region", { name: "Last terminal resource evidence" });
    expect(within(current).getByText(/current-intake/)).toBeTruthy();
    expect(within(current).getByText("0 bytes · actual-stream")).toBeTruthy();
    expect(within(terminal).getByText(/last-publication/)).toBeTruthy();
    expect(within(terminal).getByText("123 bytes · actual-stream")).toBeTruthy();
    expect(within(current).getByText("Heap unavailable")).toBeTruthy();
    expect(within(current).getByText("Unavailable (not inferred)")).toBeTruthy();
  });

  it.each([undefined, 0])("distinguishes an item count of %s from unavailable", (itemCount) => {
    renderCrons({
      groups: [
        makeGroup([
          [
            "snapshot-supply",
            makeCronStatus({
              lastRun: { startedAt: 1_699_999_940, durationMs: 200, status: "degraded", itemCount },
              recentRuns: [{ startedAt: 1_699_999_940, durationMs: 200, status: "degraded", itemCount }],
            }),
          ],
        ]),
      ],
    });

    const row = screen.getByRole("row", { name: /Supply snapshot/ });
    const itemsColumn = screen.getAllByRole("columnheader").findIndex((header) => header.textContent === "Items");
    expect(itemsColumn).toBeGreaterThanOrEqual(0);
    const cell = within(row).getAllByRole("cell")[itemsColumn]!;
    if (itemCount === undefined) {
      expect(cell.textContent).toContain("—");
      expect(within(cell).getByTitle("N/A: this job does not report an item count.")).toBeTruthy();
    } else {
      expect(cell.textContent).toBe("0");
    }
  });

  it("states Unknown explicitly when tracked and budget-only telemetry are both empty", () => {
    renderCrons({ groups: [], data: makeData({ crons: {}, budgetOnlySurfaces: [] }) });

    expect(screen.getByText("No cron job telemetry was reported. State is unknown.")).toBeTruthy();
    expect(screen.getByText("No budget-only surface telemetry was reported. State is unknown.")).toBeTruthy();
  });

});
