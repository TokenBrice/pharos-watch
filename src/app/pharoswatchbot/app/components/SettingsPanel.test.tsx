// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseState } from "../mini-app-test-fixtures";
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

afterEach(cleanup);

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

  it("selects timezone and daily-recap operations from direct props", () => {
    const onMutate = vi.fn();
    renderSettings({ onMutate });

    const compactPicker = screen.getByLabelText("Timezone") as unknown as HTMLSelectElement;
    const datalist = document.getElementById("telegram-mini-app-timezone-options");
    expect(compactPicker.options.length).toBeLessThan(20);
    expect(datalist?.querySelectorAll("option").length).toBeGreaterThan(compactPicker.options.length);

    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Paris" } });
    fireEvent.change(screen.getByLabelText("Delivery hour"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("switch", { name: "Daily recap" }));
    fireEvent.change(screen.getByLabelText("Timezone name"), { target: { value: "Europe/Paris" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply timezone" }));

    expect(onMutate).toHaveBeenNthCalledWith(1, { kind: "set-timezone", timezone: "Europe/Paris" });
    expect(onMutate).toHaveBeenNthCalledWith(2, { kind: "set-recap", enabled: false, deliveryHourLocal: 14 });
    expect(onMutate).toHaveBeenNthCalledWith(3, { kind: "set-recap", enabled: true, deliveryHourLocal: 9 });
    expect(onMutate).toHaveBeenNthCalledWith(4, { kind: "set-timezone", timezone: "Europe/Paris" });
  });

  it("renders the confirmed recap schedule and latest outcome", () => {
    const state = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        recap: { ...baseState.subscriber.recap, enabled: true, nextDueAt: 1_720_018_800, lastOutcome: "skipped_no_changes" as const },
      },
    };
    renderSettings({ state });
    expect(screen.getByText("No material changes")).toBeTruthy();
    expect(screen.getByText(/Scheduled in UTC/)).toBeTruthy();
  });

  it("retains recently confirmed zones in the compact picker", () => {
    const rendered = renderSettings();
    const honolulu = { ...baseState, subscriber: { ...baseState.subscriber, quietHours: { ...baseState.subscriber.quietHours, timezone: "Pacific/Honolulu" } } };
    const paris = { ...baseState, subscriber: { ...baseState.subscriber, quietHours: { ...baseState.subscriber.quietHours, timezone: "Europe/Paris" } } };
    rendered.rerender({ state: honolulu });
    rendered.rerender({ state: paris });

    const compactPicker = screen.getByLabelText("Timezone") as unknown as HTMLSelectElement;
    expect(Array.from(compactPicker.options).some((option) => option.text === "Recent: Pacific/Honolulu")).toBe(true);
  });

  it("hides an unavailable recap and gates enabling until timezone confirmation", () => {
    const unavailable = {
      ...baseState,
      subscriber: { ...baseState.subscriber, recap: { ...baseState.subscriber.recap, available: false } },
    };
    renderSettings({ state: unavailable });
    expect(screen.queryByRole("switch", { name: "Daily recap" })).toBeNull();

    cleanup();
    const unconfirmed = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { ...baseState.subscriber.quietHours, timezone: null },
        recap: { ...baseState.subscriber.recap, timezoneConfirmed: false },
      },
    };
    renderSettings({ state: unconfirmed });
    expect(screen.getByRole("switch", { name: "Daily recap" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Confirm a timezone below before enabling your recap.")).toBeTruthy();
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
