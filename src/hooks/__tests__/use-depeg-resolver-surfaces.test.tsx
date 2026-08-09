// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";

const mocks = vi.hoisted(() => ({
  isDepegResolverEnabled: vi.fn(),
  isDepegResolverReviewerEnabled: vi.fn(),
  useDepegResolver: vi.fn(),
  useDepegResolverReview: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverEnabled: mocks.isDepegResolverEnabled,
  isDepegResolverReviewerEnabled: mocks.isDepegResolverReviewerEnabled,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDepegResolver: mocks.useDepegResolver,
  useDepegResolverReview: mocks.useDepegResolverReview,
}));

function makeQueryResult(label: string) {
  return {
    data: { label },
    error: null,
    dataUpdatedAt: 123,
    meta: { source: label },
    refetch: vi.fn(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDepegResolverSurfaces", () => {
  it("enables DDR and DDRR queries when both flags are enabled", () => {
    const resolver = makeQueryResult("resolver");
    const reviewer = makeQueryResult("reviewer");
    mocks.isDepegResolverEnabled.mockReturnValue(true);
    mocks.isDepegResolverReviewerEnabled.mockReturnValue(true);
    mocks.useDepegResolver.mockReturnValue(resolver);
    mocks.useDepegResolverReview.mockReturnValue(reviewer);

    const { result } = renderHook(() => useDepegResolverSurfaces());

    expect(mocks.useDepegResolver).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.useDepegResolverReview).toHaveBeenCalledWith({ enabled: true });
    expect(result.current.resolverEnabled).toBe(true);
    expect(result.current.resolverReviewerEnabled).toBe(true);
    expect(result.current.resolver).toBe(resolver);
    expect(result.current.resolverReview).toBe(reviewer);
  });

  it("keeps the reviewer query disabled when DDR is disabled", () => {
    mocks.isDepegResolverEnabled.mockReturnValue(false);
    mocks.isDepegResolverReviewerEnabled.mockReturnValue(true);
    mocks.useDepegResolver.mockReturnValue(makeQueryResult("resolver"));
    mocks.useDepegResolverReview.mockReturnValue(makeQueryResult("reviewer"));

    const { result } = renderHook(() => useDepegResolverSurfaces());

    expect(mocks.isDepegResolverReviewerEnabled).not.toHaveBeenCalled();
    expect(mocks.useDepegResolver).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useDepegResolverReview).toHaveBeenCalledWith({ enabled: false });
    expect(result.current.resolverEnabled).toBe(false);
    expect(result.current.resolverReviewerEnabled).toBe(false);
  });
});
