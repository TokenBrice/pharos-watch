// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeysPanel,
  GENERATED_AT,
  makeKey,
  renderPanel,
  getApiKeysMock,
} from "./api-keys-panel-harness";

describe("ApiKeysPanel inventory", () => {
  it("offers a local retry when API key inventory loading fails", () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    getApiKeysMock().mockReturnValue({
      data: null,
      error: new Error("inventory unavailable"),
      isLoading: false,
      isFetching: false,
      refetch,
    });
    render(<ApiKeysPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Retry API key inventory" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders expired, expiring soon, inactive, and non-expiring states distinctly", () => {
    renderPanel([
      makeKey({ id: 1, name: "Expired", expiresAt: GENERATED_AT - 3600 }),
      makeKey({ id: 2, name: "Soon", expiresAt: GENERATED_AT + 2 * 24 * 60 * 60 }),
      makeKey({ id: 3, name: "Inactive", isActive: false, expiresAt: GENERATED_AT + 30 * 24 * 60 * 60 }),
      makeKey({ id: 4, name: "Permanent", expiresAt: null }),
    ]);

    expect(screen.getByText("expired")).toBeTruthy();
    expect(screen.getByText("expiring soon")).toBeTruthy();
    expect(screen.getByText("inactive")).toBeTruthy();
    expect(screen.getAllByText("non-expiring exception").length).toBeGreaterThan(0);
    expect(screen.getByText(/Expired 1h ago at/i)).toBeTruthy();
  });

  it("defaults to the attention queue and hides rows the search rejects", () => {
    renderPanel([
      makeKey({ id: 1, name: "Routine Active", expiresAt: GENERATED_AT + 30 * 24 * 60 * 60 }),
      makeKey({
        id: 2,
        name: "Route Beacon",
        ownerEmail: "beacon@example.invalid",
        keyPrefix: "beacon-prefix",
        maskedToken: "ph_live_beacon-prefix_********",
        tier: "priority",
        lastUsedRoute: "/api/beacon/latest",
      }),
      // Same attention status as Route Beacon, disjoint identity fields.
      makeKey({
        id: 3,
        name: "Attention Decoy",
        ownerEmail: "decoy@example.invalid",
        keyPrefix: "decoy-prefix",
        maskedToken: "ph_live_decoy-prefix_********",
        lastUsedRoute: "/api/decoy/latest",
      }),
    ]);

    expect(screen.getByText("Route Beacon")).toBeTruthy();
    expect(screen.getByText("Attention Decoy")).toBeTruthy();
    expect(screen.queryByText("Routine Active")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "beacon@example.invalid latest" } });
    expect(screen.getByText("Route Beacon")).toBeTruthy();
    expect(screen.queryByText("Attention Decoy")).toBeNull();

    // Every term must match: a single unmatched term rejects the row.
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "beacon-prefix absent-term" } });
    expect(screen.queryByText("Route Beacon")).toBeNull();
    expect(screen.queryByText("Attention Decoy")).toBeNull();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "" } });
    expect(screen.getByText("Routine Active")).toBeTruthy();
  });

  it("excludes rows failing each expiration, owner, tier, and traffic filter and resets to attention", () => {
    const expiringSoon = GENERATED_AT + 2 * 24 * 60 * 60;
    renderPanel([
      makeKey({
        id: 1,
        name: "Priority External",
        ownerEmail: "priority@example.invalid",
        tier: "priority",
        trafficClass: "external",
        expiresAt: expiringSoon,
      }),
      makeKey({
        id: 2,
        name: "Standard Site",
        ownerEmail: "site@example.invalid",
        tier: "standard",
        trafficClass: "site",
        expiresAt: GENERATED_AT + 20 * 24 * 60 * 60,
        isActive: false,
      }),
      makeKey({ id: 3, name: "Unassigned", ownerEmail: null, expiresAt: null }),
      // Decoys differ from key 1 in exactly one filtered dimension.
      makeKey({
        id: 4,
        name: "Other Owner",
        ownerEmail: "other@example.invalid",
        tier: "priority",
        trafficClass: "external",
        expiresAt: expiringSoon,
      }),
      makeKey({
        id: 5,
        name: "Other Tier",
        ownerEmail: "priority@example.invalid",
        tier: "standard",
        trafficClass: "external",
        expiresAt: expiringSoon,
      }),
      makeKey({
        id: 6,
        name: "Other Traffic",
        ownerEmail: "priority@example.invalid",
        tier: "priority",
        trafficClass: "site",
        expiresAt: expiringSoon,
      }),
    ]);

    fireEvent.change(screen.getByLabelText("Expiration"), { target: { value: "next-7-days" } });
    expect(screen.getByText("Priority External")).toBeTruthy();
    expect(screen.queryByText("Standard Site")).toBeNull();
    expect(screen.queryByText("Unassigned")).toBeNull();

    fireEvent.change(screen.getByLabelText("Owner filter"), { target: { value: "priority@example.invalid" } });
    expect(screen.getByText("Priority External")).toBeTruthy();
    expect(screen.queryByText("Other Owner")).toBeNull();
    expect(screen.getByText("Other Tier")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Tier filter"), { target: { value: "priority" } });
    expect(screen.getByText("Priority External")).toBeTruthy();
    expect(screen.queryByText("Other Tier")).toBeNull();
    expect(screen.getByText("Other Traffic")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Traffic filter"), { target: { value: "external" } });
    expect(screen.getByText("Priority External")).toBeTruthy();
    expect(screen.queryByText("Other Traffic")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(screen.getByText("Standard Site")).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect((screen.getByLabelText("Status") as unknown as HTMLSelectElement).value).toBe("attention");
  });

  it("sorts deterministically and paginates inventories larger than 25 rows", () => {
    const keys = Array.from({ length: 30 }, (_, index) =>
      makeKey({
        id: index + 1,
        name: `Key ${String(index + 1).padStart(2, "0")}`,
        isActive: false,
        keyPrefix: `prefix-${index + 1}`,
        maskedToken: `ph_live_prefix-${index + 1}_********`,
      }),
    );
    renderPanel(keys);

    expect(screen.getByText("Key 01")).toBeTruthy();
    expect(screen.queryByText("Key 26")).toBeNull();
    expect(screen.getByRole("navigation", { name: "API key inventory pagination" }).textContent).toContain(
      "Showing 1-25 of 30 matching keys",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go to next API key page" }));
    expect(screen.getByText("Key 26")).toBeTruthy();
    expect(screen.queryByText("Key 01")).toBeNull();

    fireEvent.change(screen.getByLabelText("Rows"), { target: { value: "50" } });
    expect(screen.getByText("Key 01")).toBeTruthy();
    expect(screen.getByText("Key 30")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });
    fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
    const tableRows = within(screen.getByRole("table", { name: "API key inventory" }))
      .getAllByRole("row")
      .slice(1);
    expect(within(tableRows[0]).getByText("Key 30")).toBeTruthy();
  });

});
