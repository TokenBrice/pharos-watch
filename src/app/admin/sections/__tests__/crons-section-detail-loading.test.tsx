// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import type { CronStatus, StatusCronDetailResponse } from "@shared/types";
import { CronsSection, type CronGroup } from "@/app/admin/sections/crons-section";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const JOBS = ["sync-blacklist", "sync-stablecoins"] as const;
const queryClients: QueryClient[] = [];

function renderWorkbench() {
  const data = makeHealthyStatusResponse();
  const cron: CronStatus = {
    runs: [{ startedAt: data.timestamp - 60, durationMs: 200, status: "error" }],
    confirmedOutputAt: null,
    healthy: false,
    expectedIntervalSec: 60,
  };
  const group: CronGroup = {
    key: "quarter-hourly",
    title: "15-minute slot",
    badge: "*/15",
    description: "Core ingestion jobs.",
    entries: JOBS.map((job) => [job, cron]),
  };
  const fetchSpy = mockFetch(JOBS.map((job) => ({
    match: (request: Request) => {
      const url = new URL(request.url);
      return url.pathname === "/api/admin/status-cron-detail" && url.searchParams.get("job") === job;
    },
    body: {
      timestamp: data.timestamp,
      job,
      cron: {
        ...cron,
        runs: [{ ...cron.runs[0]!, error: `Full detail for ${job}`, metadata: { selectedJob: job } }],
      },
      sectionErrors: {},
    } satisfies StatusCronDetailResponse,
  })), { requireMatch: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <CronsSection data={data} cronGroups={[group]} />
    </QueryClientProvider>,
  );
  return fetchSpy;
}

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("cron detail request gating", () => {
  it("fetches nothing before selection and requests each selected job only once", async () => {
    const fetchSpy = renderWorkbench();
    expect(screen.getByText("Select this job to load run history and metadata.")).toBeTruthy();
    expect(screen.queryByText("Loading run history and metadata…")).toBeNull();
    // Allow mounted query effects and another event-loop tick to run before asserting network silence.
    await act(async () => {
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 0);
      await tick.promise;
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`cron-row-${JOBS[0]}`));
    await screen.findByText(`Full detail for ${JOBS[0]}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new URL(fetchSpy.getHistory()[0]!.url).searchParams.get("job")).toBe(JOBS[0]);

    fireEvent.click(screen.getByTestId(`cron-row-${JOBS[0]}`));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId(`cron-row-${JOBS[1]}`));
    await screen.findByText(`Full detail for ${JOBS[1]}`);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.getHistory().map(({ url }) => new URL(url).searchParams.get("job"))).toEqual([...JOBS]);

    fireEvent.click(screen.getByTestId(`cron-row-${JOBS[0]}`));
    await screen.findByText(`Full detail for ${JOBS[0]}`);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await act(async () => { window.history.replaceState(null, "", "/"); });
    await waitFor(() => expect(screen.getByText("Select this job to load run history and metadata.")).toBeTruthy());
    expect(screen.queryByText(`Full detail for ${JOBS[0]}`)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("loads only the explicitly deep-linked job", async () => {
    window.history.replaceState(null, "", `?job=${JOBS[1]}`);
    const fetchSpy = renderWorkbench();
    await screen.findByText(`Full detail for ${JOBS[1]}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new URL(fetchSpy.getHistory()[0]!.url).searchParams.get("job")).toBe(JOBS[1]);
  });
});
