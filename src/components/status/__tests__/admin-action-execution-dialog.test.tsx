// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StatusPageAction } from "@shared/lib/api-endpoints";
import { AdminActionExecutionDialog } from "@/components/status/admin-action-execution-dialog";
import type {
  AdminActionDialogState,
  AdminActionExecution,
  AdminActionExecutionController,
  AdminActionExecutionRequest,
} from "@/components/status/admin-action-execution-types";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

const ASSET_SCOPE: StatusPageAction["scope"] = {
  type: "asset-or-batch",
  assetIdentifier: "stablecoin-id",
  assetLabel: "Stablecoin ID",
  assetPlaceholder: "e.g. usdt-tether",
  batchLabel: "All tracked assets",
  queryParam: "stablecoin",
};

function makeAction(overrides: Partial<StatusPageAction> = {}): StatusPageAction {
  return {
    label: "Repair records",
    path: "/api/admin/repair-records",
    confirm: "Repair the selected records?",
    destructive: false,
    method: "POST",
    acceptsStablecoinFilter: false,
    group: "recovery",
    kind: "repair",
    risk: "moderate",
    scope: { type: "global", label: "All records" },
    dryRun: { supported: false, default: false, liveSupported: true },
    expectedDuration: "Seconds",
    preconditions: [],
    blockedBy: [],
    resultMode: "immediate",
    ...overrides,
  };
}

function makeExecution(request: AdminActionExecutionRequest, status: "failed" | "unknown" = "failed"): AdminActionExecution {
  return {
    ...request,
    executionKey: "execution-1",
    laneKey: "execution-1",
    intentId: "intent-1",
    idempotencyKey: "key-1",
    request,
    status,
    requestInFlight: false,
    ok: false,
    output: '{"error":"failed"}',
    data: { error: "failed" },
    error: "failed",
    attempts: 1,
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
    executedAt: 1,
    httpStatus: 500,
    idempotentReplay: false,
    responseIdempotencyKey: "key-1",
    executionCertainty: "definite",
    warning: null,
  };
}

function makeController(current: Readonly<Record<string, AdminActionExecution>> = {}): AdminActionExecutionController {
  const fallbackRequest: AdminActionExecutionRequest = {
    action: makeAction(),
    requestPath: "/api/admin/repair-records",
    requestMethod: "POST",
    scopeKey: "global|mode:execute",
    scopeLabel: "All records",
  };
  const fallback = makeExecution(fallbackRequest);
  return {
    current,
    executions: Object.values(current),
    execute: vi.fn().mockResolvedValue({ execution: fallback, didStart: true }),
    retry: vi.fn().mockResolvedValue({ execution: fallback, didStart: true }),
    startNew: vi.fn().mockReturnValue(fallback),
  };
}

function makeDialogRequest(action: StatusPageAction, readinessChecks: readonly ActionReadinessCheck[] = []): AdminActionDialogState {
  return { action, readinessChecks, dialogId: 1 };
}

function renderDialog(
  action: StatusPageAction,
  controller = makeController(),
  readinessChecks: readonly ActionReadinessCheck[] = [],
) {
  return {
    controller,
    view: render(
      <AdminActionExecutionDialog
        request={makeDialogRequest(action, readinessChecks)}
        controller={controller}
        onClose={vi.fn()}
      />,
    ),
  };
}

describe("AdminActionExecutionDialog", () => {
  it("blocks confirmation while live readiness is blocked", () => {
    const { controller } = renderDialog(makeAction(), makeController(), [
      { id: "d1-writes", label: "D1 writes", state: "blocked", detail: "Write probe failed." },
    ]);

    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(screen.getByText("Live execution blocked")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(controller.execute).not.toHaveBeenCalled();
  });

  it("requires broad-scope acknowledgement only for live non-scoped and batch runs", () => {
    const dualModeAction = makeAction({
      dryRun: { supported: true, default: true, liveSupported: true, queryParam: "dry-run" },
    });
    const first = renderDialog(dualModeAction);

    expect(screen.queryByLabelText(/I acknowledge this live action affects/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText(/^Dry run/));
    expect(screen.getByLabelText(/I acknowledge this live action affects/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    first.view.unmount();

    renderDialog(makeAction({ scope: ASSET_SCOPE, acceptsStablecoinFilter: true }));
    expect(screen.queryByLabelText(/I acknowledge this live action affects/i)).toBeNull();
    fireEvent.click(screen.getByLabelText("Batch"));
    expect(screen.getByLabelText(/I acknowledge this live action affects/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("forces the dry-run request contract when live execution is unsupported", () => {
    const action = makeAction({
      method: "POST",
      dryRun: {
        supported: true,
        default: true,
        liveSupported: false,
        queryParam: "dry-run",
        dryRunMethod: "GET",
        liveMethod: "POST",
      },
    });
    const controller = makeController();
    render(
      <AdminActionExecutionDialog
        request={{ ...makeDialogRequest(action), initialDryRun: false }}
        controller={controller}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText(/^Dry run/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(controller.execute).toHaveBeenCalledWith(expect.objectContaining({
      requestPath: "/api/admin/repair-records?dry-run=true",
      requestMethod: "GET",
      scopeKey: "global|mode:dry-run",
    }));
  });

  it("disables retry and refuses the controller call when readiness is blocked", () => {
    const action = makeAction();
    const request: AdminActionExecutionRequest = {
      action,
      requestPath: action.path,
      requestMethod: "POST",
      scopeKey: "global|mode:execute",
      scopeLabel: "All records",
    };
    const execution = makeExecution(request, "unknown");
    const controller = makeController({ [`${action.path}\u0000${request.scopeKey}`]: execution });
    renderDialog(action, controller, [
      { id: "d1-writes", label: "D1 writes", state: "blocked", detail: "Write probe failed." },
    ]);

    const retry = screen.getByRole("button", { name: "Retry same execution" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(controller.retry).not.toHaveBeenCalled();
  });

  it("clears broad-scope acknowledgement when starting a new execution", () => {
    const action = makeAction();
    const controller = makeController();
    const view = render(
      <AdminActionExecutionDialog request={makeDialogRequest(action)} controller={controller} onClose={vi.fn()} />,
    );
    const acknowledgement = screen.getByLabelText(/I acknowledge this live action affects/i) as HTMLInputElement;
    fireEvent.click(acknowledgement);
    expect(acknowledgement.checked).toBe(true);

    const request: AdminActionExecutionRequest = {
      action,
      requestPath: action.path,
      requestMethod: "POST",
      scopeKey: "global|mode:execute",
      scopeLabel: "All records",
    };
    const execution = makeExecution(request);
    const settledController = makeController({ [`${action.path}\u0000${request.scopeKey}`]: execution });
    view.rerender(
      <AdminActionExecutionDialog request={makeDialogRequest(action)} controller={settledController} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
    expect(settledController.startNew).toHaveBeenCalledWith(request);
    expect((screen.getByLabelText(/I acknowledge this live action affects/i) as HTMLInputElement).checked).toBe(false);
  });
});
