// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, type StatusPageAction } from "@shared/lib/api-endpoints";
import { AdminActionButton } from "@/components/status/admin-action-button";
import { AdminActionExecutionProvider, useAdminActionExecutions } from "@/components/status/admin-action-execution-provider";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import { mockFetch, type MockFetchSpy } from "@shared/test-utils/mock-fetch";

const ASSET_SCOPE: StatusPageAction["scope"] = {
  type: "asset-or-batch", assetIdentifier: "stablecoin-id", assetLabel: "Stablecoin ID",
  assetPlaceholder: "e.g. usdt-tether", batchLabel: "Bounded registry batch", queryParam: "stablecoin",
};

const makeAction = (overrides: Partial<StatusPageAction> = {}): StatusPageAction => ({
  label: "Repair Blacklist Gaps", path: API_PATHS.remediateBlacklistAmountGaps(),
  confirm: "Backfill supply history snapshots?", destructive: false, method: "POST",
  acceptsStablecoinFilter: false, group: "recovery", kind: "backfill", risk: "read-only",
  scope: { type: "global", label: "Test scope" }, dryRun: { supported: false, default: false, liveSupported: true },
  expectedDuration: "Seconds", preconditions: [], blockedBy: [], resultMode: "immediate", ...overrides,
});

const renderActions = (actions: StatusPageAction[], createIdempotencyKey: () => string = () => "intent-key-for-test") => render(
  <AdminActionExecutionProvider createIdempotencyKey={createIdempotencyKey}>
    {actions.map((action, i) => <AdminActionButton key={`${action.path}-${i}`} action={action} />)}
  </AdminActionExecutionProvider>,
);

const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const clickBtn = (name: string | RegExp) => fireEvent.click(btn(name));
const openAndConfirm = (label = "Repair Blacklist Gaps") => { clickBtn(label); clickBtn("Confirm"); };
const jsonResp = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const requestIdempotencyKey = (callIndex: number): string | null =>
  new Headers(fetchMock.mock.calls[callIndex]?.[1]?.headers).get("Idempotency-Key");

function ExecutionIdentity() {
  const execution = useAdminActionExecutions()[0];
  return <output aria-label="Execution identity">{execution?.idempotencyKeyHash}</output>;
}

function selectAsset(search: string, optionName: RegExp) {
  clickBtn("Add stablecoin...");
  fireEvent.change(screen.getByRole("combobox", { name: "Search coins" }), { target: { value: search } });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

let fetchMock: MockFetchSpy;
const installFetch = (routes: Parameters<typeof mockFetch>[0] = [{ match: "/api/admin/", body: { ok: true } }]) => {
  fetchMock = mockFetch(routes, { requireMatch: true });
};

function installDeferredFetch() {
  let resolveFetch!: (response: Response) => void;
  installFetch([{ match: "/api/admin/", respond: () => new Promise<Response>((r) => { resolveFetch = r; }) }]);
  return async (body: unknown = { ok: true }) => {
    await waitFor(() => { if (typeof resolveFetch !== "function") throw new Error("fetch responder not installed"); });
    resolveFetch(jsonResp(body));
  };
}

describe("AdminActionButton", () => {
  beforeEach(() => installFetch());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("projects the SHA-256 hash of the exact key sent with the session request", async () => {
    render(
      <AdminActionExecutionProvider createIdempotencyKey={() => "key-1"}>
        <AdminActionButton action={makeAction()} /><ExecutionIdentity />
      </AdminActionExecutionProvider>,
    );
    openAndConfirm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestIdempotencyKey(0)).toBe("key-1");
    expect(screen.getByLabelText("Execution identity").textContent).toBe("be2974546978e3739e6d6da85c4be9f334ce32df2b9fd4b6ff1b55c0d57e9d44");
  });

  it("derives symbol-scoped requests and locks selected asset after settling", async () => {
    const { unmount } = renderActions([makeAction({ label: "Repair Symbol Rows", path: "/api/repair-symbol-rows", acceptsStablecoinFilter: true, scope: { ...ASSET_SCOPE, assetIdentifier: "symbol", queryParam: "symbol" }, risk: "moderate" })]);
    clickBtn("Repair Symbol Rows");
    selectAsset("Tether", /Tether.*USDT/i);
    clickBtn("Confirm");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/repair-symbol-rows?symbol=USDT");
    unmount();

    renderActions([makeAction({ acceptsStablecoinFilter: true, scope: ASSET_SCOPE, risk: "moderate" })]);
    clickBtn("Repair Blacklist Gaps");
    selectAsset("CAD Digital", /CAD Digital.*CADD/i);
    clickBtn("Confirm");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(btn("Remove CAD Digital").disabled).toBe(true);
  });

  it("requires an explicit asset or acknowledged batch scope", async () => {
    renderActions([makeAction({ acceptsStablecoinFilter: true, scope: ASSET_SCOPE, risk: "moderate" })]);
    clickBtn("Repair Blacklist Gaps");
    expect(btn("Confirm").disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Batch"));
    const ack = screen.getByLabelText(/I acknowledge this live action affects/i);
    expect(btn("Confirm").disabled).toBe(true);
    fireEvent.click(ack);
    clickBtn("Confirm");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/remediate-blacklist-amount-gaps");
  });

  it("uses dry-run contract by default and supports dual-mode live switch and preview-only actions", async () => {
    const { unmount } = renderActions([makeAction({
      label: "Remediate Blacklist Gaps", path: "/api/remediate-blacklist-amount-gaps", confirm: "Run remediation?", risk: "moderate",
      dryRun: { supported: true, default: true, liveSupported: true, queryParam: "dryRun" },
      expectedDuration: "Up to one minute", preconditions: ["Review candidate counts."], blockedBy: ["Live mode requires chain RPCs."], runbookPath: "docs/runbooks/blacklist-sync.md",
    })]);
    clickBtn("Remediate Blacklist Gaps");
    expect((screen.getByLabelText(/^Dry run/) as HTMLInputElement).checked).toBe(true);
    for (const t of ["Moderate risk", "Up to one minute", "Review candidate counts.", "Live mode requires chain RPCs."]) expect(screen.getByText(t)).toBeTruthy();
    const runbookLink = screen.getByRole("link", { name: /Open operator reference.*opens in a new tab/i });
    expect([runbookLink.getAttribute("href"), runbookLink.getAttribute("target"), runbookLink.getAttribute("rel")])
      .toEqual(["https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/blacklist-sync.md", "_blank", "noopener noreferrer"]);
    clickBtn("Confirm");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/remediate-blacklist-amount-gaps?dryRun=true");
    unmount();

    const { unmount: u2 } = renderActions([makeAction({
      label: "Audit Depegs", path: "/api/backfill-dews?repair=refresh-current&dry-run=true", confirm: "Audit depegs?", method: "GET", risk: "high",
      dryRun: { supported: true, default: true, liveSupported: true, queryParam: "dry-run", dryRunMethod: "GET", liveMethod: "POST" },
    })]);
    clickBtn("Audit Depegs");
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    expect(btn("Confirm").disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I acknowledge this live action affects/i));
    clickBtn("Confirm");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/backfill-dews?repair=refresh-current&dry-run=false");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    u2();

    renderActions([makeAction({
      label: "Preview Mint/Burn Price Repair", path: "/api/preview-repair", confirm: "Preview repairs?", kind: "inspect", risk: "high",
      dryRun: { supported: true, default: true, liveSupported: false, queryParam: "dry-run" },
    })]);
    clickBtn("Preview Mint/Burn Price Repair");
    expect(screen.getByText("Dry run only from this dashboard control.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Dry run/)).toBeNull();
    clickBtn("Confirm");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/admin/preview-repair?dry-run=true");
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
  });

  it("rechecks live readiness while open and resets broad acknowledgement on scope or mode change", async () => {
    const action = makeAction({ risk: "moderate" });
    const ready: readonly ActionReadinessCheck[] = [{ id: "d1-writes", label: "D1 writes", state: "ready", detail: "Write probe passed." }];
    const blocked: readonly ActionReadinessCheck[] = [{ id: "d1-writes", label: "D1 writes", state: "blocked", detail: "Write probe is failing." }];
    const view = render(<AdminActionExecutionProvider><AdminActionButton action={action} readinessChecks={ready} /></AdminActionExecutionProvider>);
    clickBtn("Repair Blacklist Gaps");
    fireEvent.click(screen.getByLabelText(/I acknowledge this live action affects/i));
    expect(btn("Confirm").disabled).toBe(false);
    view.rerender(<AdminActionExecutionProvider><AdminActionButton action={action} readinessChecks={blocked} /></AdminActionExecutionProvider>);
    expect(await screen.findByText("Live execution blocked")).toBeTruthy();
    expect(btn("Confirm").disabled).toBe(true);
    clickBtn("Confirm");
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount();

    renderActions([makeAction({ acceptsStablecoinFilter: true, scope: ASSET_SCOPE, risk: "high", dryRun: { supported: true, default: true, liveSupported: true, queryParam: "dry-run" } })]);
    clickBtn("Repair Blacklist Gaps");
    fireEvent.click(screen.getByLabelText("Batch"));
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    const ack = () => screen.getByLabelText(/I acknowledge this live action affects/i) as HTMLInputElement;
    fireEvent.click(ack());
    expect([ack().checked, btn("Confirm").disabled]).toEqual([true, false]);
    fireEvent.click(screen.getByLabelText("Single asset"));
    fireEvent.click(screen.getByLabelText("Batch"));
    expect([ack().checked, btn("Confirm").disabled]).toEqual([false, true]);
    fireEvent.click(ack());
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    expect(screen.queryByLabelText(/I acknowledge this live action affects/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Dry run/));
    expect(ack().checked).toBe(false);
  });

  it("retries timed-out execution with original key and creates new key only for new execution", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ error: "upstream_timeout" }, 504))
      .mockResolvedValueOnce(jsonResp({ ok: true }, 200, { "Idempotency-Key": "first-intent-key", "X-Idempotent-Replay": "true" }));
    const keys = ["first-intent-key", "second-intent-key"];
    const { unmount } = renderActions([makeAction()], () => keys.shift() ?? "unexpected-key");
    openAndConfirm();
    await screen.findByText("Outcome unknown");
    clickBtn("Retry same execution");
    await screen.findByText("Succeeded");
    expect([requestIdempotencyKey(0), requestIdempotencyKey(1)]).toEqual(["first-intent-key", "first-intent-key"]);
    expect(screen.getByText("Idempotent replay: yes")).toBeTruthy();
    unmount();

    installFetch();
    fetchMock.mockResolvedValueOnce(jsonResp({ error: "invalid_scope" }, 400)).mockResolvedValueOnce(jsonResp({ ok: true }));
    const keys2 = ["first-intent-key", "second-intent-key"];
    renderActions([makeAction()], () => keys2.shift() ?? "unexpected-key");
    openAndConfirm();
    await screen.findByText("Failed");
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    clickBtn("Start new execution");
    clickBtn("Confirm");
    await screen.findByText("Succeeded");
    expect([requestIdempotencyKey(0), requestIdempotencyKey(1)]).toEqual(["first-intent-key", "second-intent-key"]);
  });

  it("distinguishes ownership-loss 409 (unknown) from payload-reuse 409 (failed) and renders unsafe followUpUrl as text", async () => {
    installFetch([{ match: "/api/admin/", body: { error: "Idempotency reservation ownership was lost" }, status: 409, headers: { "Idempotency-Key": "intent-key-for-test", "X-Idempotent-Replay": "true" } }]);
    const { unmount } = renderActions([makeAction()]);
    openAndConfirm();
    await screen.findByText("Outcome unknown");
    expect(btn("Retry same execution")).toBeTruthy();
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.getByText(/Idempotency reservation ownership was lost/)).toBeTruthy();
    unmount();

    installFetch([{ match: "/api/admin/", body: { error: "Idempotency key reuse with different request payload" }, status: 409 }]);
    const { unmount: u2 } = renderActions([makeAction()]);
    openAndConfirm();
    await screen.findByText("Failed");
    expect(screen.queryByText("Outcome unknown")).toBeNull();
    expect(screen.getByText(/Idempotency key reuse with different request payload/)).toBeTruthy();
    u2();

    installFetch([{ match: "/api/admin/", body: { status: "succeeded", followUpUrl: "//evil.example/jobs/42" } }]);
    renderActions([makeAction()]);
    openAndConfirm();
    expect((await screen.findByText("//evil.example/jobs/42")).closest("a")).toBeNull();
  });

  it("coalesces double confirmation, locks dismissal while running, shares state across duplicates, and retains result across remount", async () => {
    const finish1 = installDeferredFetch();
    const { unmount } = renderActions([makeAction()]);
    clickBtn("Repair Blacklist Gaps");
    const confirmButton = btn("Confirm");
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(btn("Cancel").disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await finish1();
    await screen.findByText("Succeeded");
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(btn("Start new execution")).toBeTruthy();
    unmount();

    const finish2 = installDeferredFetch();
    const action = makeAction();
    const { unmount: u2 } = renderActions([action, action]);
    fireEvent.click(screen.getAllByRole("button", { name: "Repair Blacklist Gaps" })[0]);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    clickBtn("Confirm");
    expect(document.querySelectorAll('[data-execution-status="running"]')).toHaveLength(2);
    await finish2({ ok: true, run: "shared-result" });
    await screen.findByText("Succeeded");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((b) => b.getAttribute("data-slot") === "button")!);
    fireEvent.click(screen.getAllByRole("button", { name: "Repair Blacklist Gaps" })[1]);
    expect(await screen.findByText(/shared-result/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    u2();

    installFetch();
    const createKey = () => "persistent-intent-key";
    const view = render(<AdminActionExecutionProvider createIdempotencyKey={createKey}><AdminActionButton action={action} /></AdminActionExecutionProvider>);
    openAndConfirm();
    await screen.findByText("Succeeded");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    view.rerender(<AdminActionExecutionProvider createIdempotencyKey={createKey}><div>Another operator lane</div></AdminActionExecutionProvider>);
    view.rerender(<AdminActionExecutionProvider createIdempotencyKey={createKey}><AdminActionButton action={action} /></AdminActionExecutionProvider>);
    clickBtn("Repair Blacklist Gaps");
    expect(await screen.findByText("Succeeded")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
