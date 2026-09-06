// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { useChainDetail, useChains } from "../use-chains";

describe("useChains", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
    useRegisteredApiQueryMock.mockReturnValue({ data: undefined, meta: null });
  });

  it("uses the shared chains endpoint polling contract", () => {
    renderHook(() => useChains());

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["chains"],
        path: "/api/chains",
        responseMode: "meta",
      }),
    );
  });

  it("uses the chain-scoped endpoint for detail data", () => {
    renderHook(() => useChainDetail("ethereum"));

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["chains", "detail", "ethereum"],
        path: "/api/chains?chain=ethereum",
        responseMode: "meta",
      }),
    );
  });
});
