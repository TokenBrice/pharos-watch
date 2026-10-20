// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { baseState } from "@shared/test-utils/telegram-mini-app-state";
import type { SettingsPanelProps } from "./SettingsPanel";
import { SettingsPanel } from "./SettingsPanel";

function renderSettings(overrides: Partial<SettingsPanelProps> = {}): { props: SettingsPanelProps; rerender: (next?: Partial<SettingsPanelProps>) => void } {
  const props: SettingsPanelProps = {
    state: baseState,
    canMutate: true,
    canReadPortability: false,
    isPortabilityRequestBusy: false,
    isMutating: false,
    pendingOperation: null,
    onMutate: vi.fn(),
    globalAlerts: baseState.subscriber.globalAlerts,
    onUnsubscribeAll: vi.fn(),
    onForgetMe: vi.fn(),
    hasShowConfirm: false,
    onExportWatchlist: async () => null,
    onPreviewWatchlistImport: async () => null,
    onConfirmWatchlistImport: async () => null,
    ...overrides,
  };
  const view = render(<SettingsPanel {...props} />);
  return {
    props,
    rerender: (next = {}) => view.rerender(<SettingsPanel {...props} {...next} />),
  };
}


describe("SettingsPanel", () => {
  it("renders global controls and selects typed operations", () => {
    const onMutate = vi.fn();
    renderSettings({ onMutate });

    fireEvent.click(screen.getByRole("button", { name: "Safety" }));
    fireEvent.click(screen.getByRole("button", { name: "Set global depeg step to 500 bps" }));

    expect(onMutate).toHaveBeenNthCalledWith(1, { kind: "set-global", alertType: "safety", enabled: true });
    expect(onMutate).toHaveBeenNthCalledWith(2, { kind: "set-global-depeg-step", depegStepBps: 500 });
  });

  it("keeps quiet-hour summaries and rejects equal start/end selections", () => {
    const onMutate = vi.fn();
    const state = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, timezone: "Europe/Paris" },
      },
    };
    renderSettings({ state, onMutate });

    expect(screen.getByText("Quiet hours: 22:00–07:00 Europe/Paris")).toBeTruthy();
    const start = screen.getByLabelText("Start");
    fireEvent.change(start, { target: { value: "7" } });
    expect(screen.getByText("Start and end must differ. For all-day silence, turn alert toggles off or unsubscribe instead.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save quiet hours" })).toHaveProperty("disabled", true);

    fireEvent.change(start, { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable quiet hours" }));
    expect(onMutate).toHaveBeenNthCalledWith(1, { kind: "set-quiet-hours", enabled: true, startHourUtc: 21, endHourUtc: 7 });
    expect(onMutate).toHaveBeenNthCalledWith(2, { kind: "set-quiet-hours", enabled: false });
  });

  it("selects timezone operations from direct props", () => {
    const onMutate = vi.fn();
    renderSettings({ onMutate });

    const compactPicker = screen.getByLabelText("Timezone") as unknown as HTMLSelectElement;
    const datalist = document.getElementById("telegram-mini-app-timezone-options");
    expect(compactPicker.options.length).toBeLessThan(20);
    expect(datalist?.querySelectorAll("option").length).toBeGreaterThan(compactPicker.options.length);

    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Paris" } });
    fireEvent.change(screen.getByLabelText("Timezone name"), { target: { value: "Europe/Paris" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply timezone" }));

    expect(onMutate).toHaveBeenNthCalledWith(1, { kind: "set-timezone", timezone: "Europe/Paris" });
    expect(onMutate).toHaveBeenNthCalledWith(2, { kind: "set-timezone", timezone: "Europe/Paris" });
  });

  it("removes personalized recap controls while retaining quiet hours and timezone", () => {
    renderSettings();
    expect(screen.queryByRole("switch", { name: "Daily recap" })).toBeNull();
    expect(screen.queryByLabelText("Delivery hour")).toBeNull();
    expect(screen.getByRole("heading", { name: "Quiet hours" })).toBeTruthy();
    expect(screen.getByLabelText("Timezone")).toBeTruthy();
  });

  it("confirms UTC directly from an unconfirmed fallback and keeps clearing distinct", () => {
    const state = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { ...baseState.subscriber.quietHours, timezone: null },
      },
    };
    const { props, rerender } = renderSettings({ state });
    expect(screen.getByRole("button", { name: "Apply timezone" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm UTC" }));
    expect(props.onMutate).toHaveBeenCalledWith({ kind: "set-timezone", timezone: "UTC" });

    rerender({ state: baseState });
    expect(screen.getByRole("button", { name: "Apply timezone" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Clear timezone (UTC fallback)" }));
    expect(props.onMutate).toHaveBeenLastCalledWith({ kind: "set-timezone", timezone: null });
    rerender({ state });
    expect(screen.getByRole("button", { name: "Confirm UTC" })).toHaveProperty("disabled", false);
  });

  it("releases acknowledged quiet-hour drafts before a later confirmed refresh", () => {
    const quietState = (startHourUtc: number, endHourUtc: number) => ({
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { enabled: true, startHourUtc, endHourUtc, timezone: "UTC" },
      },
    });
    const { props, rerender } = renderSettings({ state: quietState(22, 7) });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "23" } });
    expect(screen.getByText("Unsaved quiet-hour changes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    expect(props.onMutate).toHaveBeenCalledWith({ kind: "set-quiet-hours", enabled: true, startHourUtc: 23, endHourUtc: 7 });
    rerender({ state: quietState(23, 7) });
    expect(screen.queryByText("Unsaved quiet-hour changes.")).toBeNull();
    rerender({ state: quietState(20, 6) });
    expect(screen.getByLabelText("Start")).toHaveProperty("value", "20");
    expect(screen.getByLabelText("End")).toHaveProperty("value", "6");
    expect(screen.getByText("Quiet hours: 20:00–06:00 UTC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    expect(props.onMutate).toHaveBeenLastCalledWith({ kind: "set-quiet-hours", enabled: true, startHourUtc: 20, endHourUtc: 6 });
  });

  it("uses an explicit Arm/Confirm/Cancel fallback when showConfirm is absent", () => {
    const onUnsubscribeAll = vi.fn();
    const onForgetMe = vi.fn();
    renderSettings({ onUnsubscribeAll, onForgetMe, hasShowConfirm: false });

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));
    expect(screen.getByRole("button", { name: "Confirm unsubscribe from all alerts" })).toBeTruthy();
    expect(onUnsubscribeAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Unsubscribe from all" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unsubscribe from all alerts" }));
    expect(onUnsubscribeAll).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    expect(screen.getByRole("button", { name: "Confirm delete all my data forever" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete all my data forever" }));
    expect(onForgetMe).toHaveBeenCalledOnce();
  });

  it("delegates destructive actions immediately when native confirmation is available", () => {
    const onUnsubscribeAll = vi.fn();
    const onForgetMe = vi.fn();
    renderSettings({ onUnsubscribeAll, onForgetMe, hasShowConfirm: true });

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    expect(onUnsubscribeAll).toHaveBeenCalledOnce();
    expect(onForgetMe).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
  });
});
