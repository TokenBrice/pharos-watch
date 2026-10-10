// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseState, makeMiniAppState, makeSubscribedCoin } from "../mini-app-test-fixtures";
import type { StatusPanelProps } from "./StatusPanel";
import { StatusPanel } from "./StatusPanel";

function renderStatus(overrides: Partial<StatusPanelProps> = {}): StatusPanelProps {
  const props: StatusPanelProps = {
    state: baseState,
    nowSec: 1_700_000_000,
    canMutate: true,
    isMutating: false,
    pendingOperation: null,
    onMutate: vi.fn(),
    homeHeadline: "2 global alert families, 1 explicit coin.",
    homeScreenStatus: null,
    onAddToHomeScreen: vi.fn(),
    ...overrides,
  };
  render(<StatusPanel {...props} />);
  return props;
}

afterEach(cleanup);

describe("StatusPanel", () => {
  const disabledGlobals = { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false };

  it.each([
    ["retained empty subscriber", makeMiniAppState({ subscriber: { globalAlerts: disabledGlobals }, subscriptions: [], presets: [] }), "No enabled alerts"],
    ["explicit-off row", makeMiniAppState({ subscriber: { globalAlerts: disabledGlobals }, subscriptions: [makeSubscribedCoin({})] }), "No enabled alerts"],
    ["indefinite pause", makeMiniAppState({ subscriber: { snoozeUntilTs: 4_102_444_800 } }), "Alerts are paused indefinitely"],
    ["future snooze", makeMiniAppState({ subscriber: { snoozeUntilTs: 9_000_000_000 } }), "Alerts are temporarily snoozed"],
  ])("does not claim active delivery for %s", (_scenario, state, heading) => {
    renderStatus({ state });
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Alerts are active" })).toBeNull();
    expect(screen.getByText("Last delivery")).toBeTruthy();
  });

  it.each([
    ["global", makeMiniAppState({ subscriptions: [] })],
    ["direct", makeMiniAppState({ subscriber: { globalAlerts: disabledGlobals }, subscriptions: [makeSubscribedCoin({ freeze: true })] })],
    ["preset", makeMiniAppState({ subscriber: { globalAlerts: disabledGlobals }, subscriptions: [], presets: [{ id: "usd-top25", label: "USD Top 25", alertTypes: { dews: true, depeg: false, safety: false }, depegStepBps: null }] })],
    ["expired snooze", makeMiniAppState({ subscriber: { snoozeUntilTs: 1 } })],
  ])("claims active alerts for enabled %s coverage", (_scenario, state) => {
    renderStatus({ state });
    expect(screen.getByRole("heading", { name: "Alerts are active" })).toBeTruthy();
  });

  it("selects recommended setup, snooze, and pause operations", () => {
    const onMutate = vi.fn();
    renderStatus({ onMutate });

    fireEvent.click(screen.getByRole("button", { name: "Use recommended setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alerts for 4h" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause all alerts indefinitely" }));

    expect(onMutate).toHaveBeenNthCalledWith(1, { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] });
    expect(onMutate).toHaveBeenNthCalledWith(2, { kind: "set-snooze", durationToken: "4h" });
    expect(onMutate).toHaveBeenNthCalledWith(3, { kind: "pause" });
  });

  it("renders paused and timed snoozes with the matching clear operation", () => {
    const onMutate = vi.fn();
    const paused = { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: 4_102_444_800 } };
    renderStatus({ state: paused, onMutate });
    expect(screen.getByText("Paused indefinitely")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume alerts" }));
    expect(onMutate).toHaveBeenCalledWith({ kind: "clear-snooze" });

    cleanup();
    const timed = { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: 1_800_000_000 } };
    renderStatus({ state: timed, onMutate });
    expect(screen.getByText(/Quiet until/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear snooze" }));
    expect(onMutate).toHaveBeenLastCalledWith({ kind: "clear-snooze" });
  });

  it("expires a timed snooze exactly when the supplied client clock reaches its deadline", () => {
    const deadline = 1_800_000_000;
    const props = renderStatus({
      state: makeMiniAppState({ subscriber: { snoozeUntilTs: deadline } }),
      nowSec: deadline - 1,
    });
    expect(screen.getByRole("heading", { name: "Alerts are temporarily snoozed" })).toBeTruthy();
    expect(screen.getByText(/Quiet until/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear snooze" })).toBeTruthy();

    cleanup();
    render(<StatusPanel {...props} nowSec={deadline} />);
    expect(screen.getByRole("heading", { name: "Alerts are active" })).toBeTruthy();
    expect(screen.queryByText(/Quiet until/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear snooze" })).toBeNull();
    expect(screen.getByRole("button", { name: "Snooze alerts for 4h" })).toBeTruthy();
  });

  it("shows group-only and recent-delivery failure guidance without enabling writes", () => {
    const state = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "not-private" as const },
      health: { ...baseState.health, recentFailureClass: "blocked" },
    };
    renderStatus({ state, canMutate: false });

    expect(screen.getByText("Group settings are command-only for now")).toBeTruthy();
    expect(screen.getByText("/settings@PharosWatchBot").tagName).toBe("CODE");
    expect(screen.getByText("Alerts paused by Telegram")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use recommended setup" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Quiet hours")).toBeTruthy();
    expect(screen.getByText("Last delivery")).toBeTruthy();
  });

  it("shows optional home-screen and sample-alert actions only when capabilities are supplied", () => {
    const onAddToHomeScreen = vi.fn();
    const onSendSample = vi.fn();
    renderStatus({ homeScreenStatus: "missed", onAddToHomeScreen, onSendSample });
    fireEvent.click(screen.getByRole("button", { name: "Add to home screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Send me a sample alert" }));
    expect(onAddToHomeScreen).toHaveBeenCalledOnce();
    expect(onSendSample).toHaveBeenCalledOnce();

    cleanup();
    renderStatus({ homeScreenStatus: "added" });
    expect(screen.queryByRole("button", { name: "Add to home screen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send me a sample alert" })).toBeNull();
  });
});
