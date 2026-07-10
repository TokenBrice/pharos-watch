// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryCandidate } from "@shared/types";
import { DiscoveryCandidatesCard } from "../discovery-candidates";

const NOW = 1_700_000_000;

function candidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    id: overrides.id ?? 1,
    geckoId: overrides.geckoId ?? "big-usd",
    llamaId: overrides.llamaId ?? null,
    name: overrides.name ?? "Big Dollar",
    symbol: overrides.symbol ?? "BIG",
    marketCap: overrides.marketCap ?? 50_000_000,
    source: overrides.source ?? "both",
    firstSeen: overrides.firstSeen ?? NOW - 10 * 86_400,
    lastSeen: overrides.lastSeen ?? NOW - 60,
    daysSeen: overrides.daysSeen ?? 10,
    dismissed: overrides.dismissed ?? false,
  };
}

function idempotencyKey(callIndex: number): string | null {
  const [, init] = vi.mocked(fetch).mock.calls[callIndex] ?? [];
  return new Headers(init?.headers).get("Idempotency-Key");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DiscoveryCandidatesCard", () => {
  it("uses unique object-aware names and confirms the exact dismissal effect", () => {
    render(
      <DiscoveryCandidatesCard
        candidates={[candidate(), candidate({ id: 2, symbol: "SML", name: "Small Dollar", geckoId: "small-usd" })]}
        nowSeconds={NOW}
      />,
    );

    expect(screen.getByRole("button", { name: "Dismiss BIG (Big Dollar, candidate ID 1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss SML (Small Dollar, candidate ID 2)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss BIG (Big Dollar, candidate ID 1)" }));

    expect(screen.getByRole("heading", { name: "Dismiss discovery candidate" })).toBeTruthy();
    expect(screen.getByText(/Moderate.*audited coverage-triage mutation/i)).toBeTruthy();
    expect(screen.getByText(/Removes this candidate from the active discovery queue/i)).toBeTruthy();
    expect(screen.getByText(/no restore control/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm dismiss of BIG (candidate ID 1)" })).toBeTruthy();
  });

  it("coalesces double confirmation and removes the confirmed object", async () => {
    let resolveResponse!: (response: Response) => void;
    const responseGate = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.mocked(fetch).mockReturnValue(responseGate);
    const onDismissed = vi.fn();
    render(<DiscoveryCandidatesCard candidates={[candidate()]} nowSeconds={NOW} onDismissed={onDismissed} />);

    fireEvent.click(screen.getByRole("button", { name: /Dismiss BIG/ }));
    const confirm = screen.getByRole("button", { name: /Confirm dismiss of BIG/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(idempotencyKey(0)).toBeTruthy();
    resolveResponse(
      new Response(JSON.stringify({ ok: true, alreadyDismissed: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() => expect(screen.queryByRole("button", { name: /Dismiss BIG/ })).toBeNull());
    expect(onDismissed).toHaveBeenCalledOnce();
  });

  it("retries an uncertain dismissal with the same key and surfaces replay metadata", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockImplementationOnce(async (_input, init) => {
        const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return new Response(JSON.stringify({ ok: true, alreadyDismissed: false }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "X-Idempotent-Replay": "true",
          },
        });
      });
    render(<DiscoveryCandidatesCard candidates={[candidate()]} nowSeconds={NOW} />);

    fireEvent.click(screen.getByRole("button", { name: /Dismiss BIG/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm dismiss of BIG/ }));
    await screen.findByText("Outcome unknown");
    const firstKey = idempotencyKey(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry same intent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(idempotencyKey(1)).toBe(firstKey);
    expect(await screen.findByText(/replay yes/i)).toBeTruthy();
  });

  it("keeps a business conflict definite instead of offering same-key reconciliation", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Idempotency key reuse with different request payload" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<DiscoveryCandidatesCard candidates={[candidate()]} nowSeconds={NOW} />);

    fireEvent.click(screen.getByRole("button", { name: /Dismiss BIG/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm dismiss of BIG/ }));

    expect(await screen.findByText("Action failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry same intent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start new dismiss intent" })).toBeTruthy();
  });
});
