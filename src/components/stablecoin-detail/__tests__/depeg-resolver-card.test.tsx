// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StablecoinDepegResolverCard } from "../depeg-resolver-card";
import { DDR_TEST_META, makeFrozenDdrV2Row } from "@/components/depeg-resolver-test-support";
import { cleanupFrontendTest } from "@/test-utils/frontend";

const { queryMock, enabledMock } = vi.hoisted(() => ({ queryMock: vi.fn(), enabledMock: vi.fn(() => true) }));
vi.mock("@/hooks/api-hooks", () => ({ useDepegResolver: queryMock }));
vi.mock("@/lib/feature-flags", () => ({ isDepegResolverEnabled: enabledMock }));

afterEach(() => {
  cleanupFrontendTest();
  vi.clearAllMocks();
  enabledMock.mockReturnValue(true);
});

describe("StablecoinDepegResolverCard", () => {
  it("omits only a healthy empty resolver snapshot", () => {
    queryMock.mockReturnValue({ data: { _meta: DDR_TEST_META, rows: [] }, error: null, refetch: vi.fn() });
    const { container } = render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows request failure without data and allows a retry", () => {
    const refetch = vi.fn();
    queryMock.mockReturnValue({ data: undefined, error: new Error("HTTP 502"), refetch });
    render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry depeg duration resolver" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the reason and retry for a degraded empty snapshot", () => {
    const refetch = vi.fn();
    queryMock.mockReturnValue({
      data: { _meta: { ...DDR_TEST_META, degraded: true, degradedReason: "no-valid-snapshot" }, rows: [] },
      error: null, refetch,
    });
    render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Snapshot reason: no-valid-snapshot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry depeg duration resolver" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("retains stale-cache rows behind the resolver qualification", () => {
    queryMock.mockReturnValue({
      data: { _meta: { ...DDR_TEST_META, degraded: true, degradedReason: "stale-cache" }, rows: [makeFrozenDdrV2Row()] },
      error: null, refetch: vi.fn(),
    });
    render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    const region = screen.getByRole("region", { name: "Depeg Duration Resolver for LUSD" });
    expect(region.textContent).toContain("stale");
    expect(region.querySelectorAll("a[href='/stablecoin/lusd-liquity']").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
