// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, type StatusPageAction } from "@shared/lib/api-endpoints";
import { AdminActionButton } from "@/components/status/admin-action-button";

function makeAction(overrides: Partial<StatusPageAction> = {}): StatusPageAction {
  return {
    label: "Backfill Supply",
    path: API_PATHS.backfillSupplyHistory(),
    confirm: "Backfill supply history snapshots?",
    destructive: false,
    method: "POST",
    acceptsStablecoinFilter: true,
    ...overrides,
  };
}

describe("AdminActionButton", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
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
    render(<AdminActionButton action={makeAction()} />);

    fireEvent.click(screen.getByRole("button", { name: "Backfill Supply" }));
    fireEvent.change(screen.getByLabelText(/Stablecoin ID/i), {
      target: { value: "cadd-cad-digital" },
    });
    fireEvent.click(
      screen.getByLabelText(/Allow constant-price fallback for non-USD backfill/i),
    );
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
    render(
      <AdminActionButton
        action={makeAction({
          label: "Backfill CG Prices",
          path: "/api/backfill-cg-prices",
          confirm: "Backfill CoinGecko prices?",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Backfill CG Prices" }));

    expect(
      screen.queryByLabelText(/Allow constant-price fallback for non-USD backfill/i),
    ).toBeNull();
  });
});
