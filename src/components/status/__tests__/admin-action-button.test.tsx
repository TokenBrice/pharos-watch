// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, type StatusPageAction } from "@shared/lib/api-endpoints";
import { AdminActionButton } from "@/components/status/admin-action-button";
import { AdminActionExecutionProvider } from "@/components/status/admin-action-execution-provider";

const ASSET_SCOPE: StatusPageAction["scope"] = {
  type: "asset-or-batch",
  assetIdentifier: "stablecoin-id",
  assetLabel: "Stablecoin ID",
  assetPlaceholder: "e.g. usdt-tether",
  batchLabel: "Bounded registry batch",
  queryParam: "stablecoin",
};

function makeAction(overrides: Partial<StatusPageAction> = {}): StatusPageAction {
  return {
    label: "Backfill Supply",
    path: API_PATHS.backfillSupplyHistory(),
    confirm: "Backfill supply history snapshots?",
    destructive: false,
    method: "POST",
    acceptsStablecoinFilter: false,
    group: "recovery",
    kind: "backfill",
    risk: "read-only",
    scope: { type: "global", label: "Test scope" },
    dryRun: { supported: false, default: false, liveSupported: true },
    expectedDuration: "Seconds",
    preconditions: [],
    blockedBy: [],
    resultMode: "immediate",
    ...overrides,
  };
}

function renderActions(actions: StatusPageAction[], createIdempotencyKey: () => string = () => "intent-key-for-test") {
  return render(
    <AdminActionExecutionProvider createIdempotencyKey={createIdempotencyKey}>
      {actions.map((action, index) => (
        <AdminActionButton key={`${action.path}-${index}`} action={action} />
      ))}
    </AdminActionExecutionProvider>,
  );
}

function requestIdempotencyKey(callIndex: number): string | null {
  const [, init] = fetchMock.mock.calls[callIndex] ?? [];
  return new Headers(init?.headers).get("Idempotency-Key");
}

const fetchMock = vi.fn<typeof fetch>();

describe("AdminActionButton", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adds non-USD fallback query for backfill supply when toggle is enabled", async () => {
    renderActions([makeAction({ acceptsStablecoinFilter: true, scope: ASSET_SCOPE, risk: "moderate" })]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.change(screen.getByLabelText("Stablecoin ID"), {
      target: { value: "cadd-cad-digital" },
    });
    fireEvent.click(screen.getByLabelText(/Allow constant-price fallback for non-USD backfill/i));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "/api/admin/backfill-supply-history?stablecoin=cadd-cad-digital&allow-constant-price-fallback=true",
    );
    expect(init?.method).toBe("POST");
  });

  it("does not show non-USD fallback toggle for non-supply actions", () => {
    renderActions([
      makeAction({
        label: "Backfill CG Prices",
        path: "/api/backfill-cg-prices",
        confirm: "Backfill CoinGecko prices?",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill CG Prices" }));

    expect(screen.queryByLabelText(/Allow constant-price fallback for non-USD backfill/i)).toBeNull();
  });

  it("requires an explicit asset or acknowledged batch scope", async () => {
    renderActions([
      makeAction({
        acceptsStablecoinFilter: true,
        scope: ASSET_SCOPE,
        risk: "moderate",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Batch"));
    const acknowledgement = screen.getByLabelText(/I acknowledge this live action affects/i);
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(acknowledgement);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/backfill-supply-history");
  });

  it("uses the configured dry-run query contract by default", async () => {
    renderActions([
      makeAction({
        label: "Remediate Blacklist Gaps",
        path: "/api/remediate-blacklist-amount-gaps",
        confirm: "Run remediation?",
        risk: "moderate",
        dryRun: {
          supported: true,
          default: true,
          liveSupported: true,
          queryParam: "dryRun",
        },
        expectedDuration: "Up to one minute",
        preconditions: ["Review candidate counts."],
        blockedBy: ["Live mode requires chain RPCs."],
        runbookPath: "docs/data-pipeline.md",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remediate Blacklist Gaps" }));
    expect((screen.getByLabelText(/^Dry run/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Moderate risk")).toBeTruthy();
    expect(screen.getByText("Up to one minute")).toBeTruthy();
    expect(screen.getByText("Review candidate counts.")).toBeTruthy();
    expect(screen.getByText("Live mode requires chain RPCs.")).toBeTruthy();
    const runbookLink = screen.getByRole("link", {
      name: /Open operator reference.*opens in a new tab/i,
    });
    expect(runbookLink.getAttribute("href")).toBe(
      "https://github.com/TokenBrice/pharos-watch/blob/main/docs/data-pipeline.md",
    );
    expect(runbookLink.getAttribute("target")).toBe("_blank");
    expect(runbookLink.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/remediate-blacklist-amount-gaps?dryRun=true");
  });

  it("switches a dual-mode dry run to its live method only after acknowledgement", async () => {
    renderActions([
      makeAction({
        label: "Audit Depegs",
        path: "/api/audit-depeg-history?dry-run=true",
        confirm: "Audit depegs?",
        method: "GET",
        risk: "high",
        dryRun: {
          supported: true,
          default: true,
          liveSupported: true,
          queryParam: "dry-run",
          dryRunMethod: "GET",
          liveMethod: "POST",
        },
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Audit Depegs" }));
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I acknowledge this live action affects/i));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/audit-depeg-history?dry-run=false");
    expect(init?.method).toBe("POST");
  });

  it("resets broad acknowledgement when scope or execution mode changes", () => {
    renderActions([
      makeAction({
        acceptsStablecoinFilter: true,
        scope: ASSET_SCOPE,
        risk: "high",
        dryRun: {
          supported: true,
          default: true,
          liveSupported: true,
          queryParam: "dry-run",
        },
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByLabelText("Batch"));
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    let acknowledgement = screen.getByLabelText(/I acknowledge this live action affects/i) as HTMLInputElement;
    fireEvent.click(acknowledgement);
    expect(acknowledgement.checked).toBe(true);
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText("Single asset"));
    fireEvent.click(screen.getByLabelText("Batch"));
    acknowledgement = screen.getByLabelText(/I acknowledge this live action affects/i) as HTMLInputElement;
    expect(acknowledgement.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(acknowledgement);
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    expect(screen.queryByLabelText(/I acknowledge this live action affects/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    acknowledgement = screen.getByLabelText(/I acknowledge this live action affects/i) as HTMLInputElement;
    expect(acknowledgement.checked).toBe(false);
  });

  it("keeps preview-only actions on their dry-run request contract", async () => {
    renderActions([
      makeAction({
        label: "Preview Mint/Burn Price Repair",
        path: "/api/backfill-mint-burn-prices",
        confirm: "Preview repairs?",
        kind: "inspect",
        risk: "high",
        dryRun: {
          supported: true,
          default: true,
          liveSupported: false,
          queryParam: "dry-run",
        },
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Preview Mint/Burn Price Repair" }));
    expect(screen.getByText("Dry run only from this dashboard control.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Dry run/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/backfill-mint-burn-prices?dry-run=true");
    expect(init?.method).toBe("POST");
  });

  it("retries a timed-out execution with the original idempotency key", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "upstream_timeout" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "intent-key-for-test",
            "X-Idempotent-Replay": "true",
          },
        }),
      );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Outcome unknown");

    fireEvent.click(screen.getByRole("button", { name: "Retry same execution" }));
    await screen.findByText("Succeeded");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestIdempotencyKey(0)).toBe("intent-key-for-test");
    expect(requestIdempotencyKey(1)).toBe("intent-key-for-test");
    expect(screen.getByText("Idempotent replay: yes")).toBeTruthy();
  });

  it("creates a new key only after the operator starts a new execution", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_scope" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const keys = ["first-intent-key", "second-intent-key"];
    renderActions([makeAction()], () => keys.shift() ?? "unexpected-key");

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Failed");

    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Succeeded");

    expect(requestIdempotencyKey(0)).toBe("first-intent-key");
    expect(requestIdempotencyKey(1)).toBe("second-intent-key");
  });

  it("timestamps a prepared intent when its request starts", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const onFinished = vi.fn();
    const action = makeAction();
    render(
      <AdminActionExecutionProvider createIdempotencyKey={() => `intent-${now}`}>
        <AdminActionButton action={action} onFinished={onFinished} />
      </AdminActionExecutionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Succeeded");

    now = 2_000_000;
    fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
    now = 2_600_000;
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));

    const execution = onFinished.mock.calls[1]?.[0];
    expect(execution.createdAt).toBe(2_000_000);
    expect(execution.executedAt).toBe(2_600);
  });

  it("treats a same-key idempotency ownership-loss conflict as unknown", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Idempotency reservation ownership was lost" }), {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "intent-key-for-test",
          "X-Idempotent-Replay": "true",
        },
      }),
    );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await screen.findByText("Outcome unknown");
    expect(screen.getByRole("button", { name: "Retry same execution" })).toBeTruthy();
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.getByText(/Idempotency reservation ownership was lost/).className).toContain("bg-amber-500/10");
  });

  it("keeps a payload-reuse 409 as a definite failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Idempotency key reuse with different request payload" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await screen.findByText("Failed");
    expect(screen.queryByText("Outcome unknown")).toBeNull();
    expect(screen.getByText(/Idempotency key reuse with different request payload/).className).toContain(
      "bg-red-500/10",
    );
  });

  it("coalesces a double confirmation into one request", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await screen.findByText("Succeeded");
  });

  it("shares running and result state across duplicate action instances", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const action = makeAction({ acceptsStablecoinFilter: false });
    renderActions([action, action]);

    fireEvent.click(screen.getAllByRole("button", { name: "Backfill Supply" })[0]);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(document.querySelectorAll('[data-execution-status="running"]')).toHaveLength(2);
    resolveFetch(
      new Response(JSON.stringify({ ok: true, run: "shared-result" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await screen.findByText("Succeeded");
    const footerClose = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.getAttribute("data-slot") === "button");
    expect(footerClose).toBeTruthy();
    fireEvent.click(footerClose!);

    fireEvent.click(screen.getAllByRole("button", { name: "Backfill Supply" })[1]);
    expect(await screen.findByText(/shared-result/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("presents structured execution identity before the raw JSON disclosure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "queued",
          jobId: "job-42",
          queueId: "queue-a",
          nextCursor: "cursor-9",
          followUpUrl: "/admin/crons",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("heading", { name: "Action queued" })).toBeTruthy();
    expect(screen.getByText("job-42")).toBeTruthy();
    expect(screen.getByText("queue-a")).toBeTruthy();
    expect(screen.getByText("cursor-9")).toBeTruthy();
    expect(screen.getByRole("link", { name: "/admin/crons" }).getAttribute("href")).toBe("/admin/crons");
    const raw = screen.getByText("Raw JSON response").closest("details");
    expect(raw?.hasAttribute("open")).toBe(false);
    expect(screen.getByText(/"jobId": "job-42"/)).toBeTruthy();
  });

  it("renders an unsafe follow-up value as inert text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "succeeded", followUpUrl: "//evil.example/jobs/42" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const followUp = await screen.findByText("//evil.example/jobs/42");
    expect(followUp.closest("a")).toBeNull();
  });

  it("does not offer another confirmation after a successful execution", async () => {
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Succeeded");

    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start new execution" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps execution results when the action lane unmounts and remounts", async () => {
    const action = makeAction();
    const createIdempotencyKey = () => "persistent-intent-key";
    const view = render(
      <AdminActionExecutionProvider createIdempotencyKey={createIdempotencyKey}>
        <AdminActionButton action={action} />
      </AdminActionExecutionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Succeeded");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    view.rerender(
      <AdminActionExecutionProvider createIdempotencyKey={createIdempotencyKey}>
        <div>Another operator lane</div>
      </AdminActionExecutionProvider>,
    );
    view.rerender(
      <AdminActionExecutionProvider createIdempotencyKey={createIdempotencyKey}>
        <AdminActionButton action={action} />
      </AdminActionExecutionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    expect(await screen.findByText("Succeeded")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and removes casual dismissal while a request is running", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderActions([makeAction()]);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    resolveFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await screen.findByText("Succeeded");
  });
});
