import { describe, expect, it, vi } from "vitest";
import { fetchPagedTokenPools } from "../paged-token-pools";

describe("fetchPagedTokenPools", () => {
  it("accumulates pages until a short page is returned", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([{ id: 3 }]);

    const pools = await fetchPagedTokenPools({
      maxPages: 4,
      pageSize: 2,
      fetchPage,
    });

    expect(pools).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on an empty page", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([]);

    const pools = await fetchPagedTokenPools({
      maxPages: 3,
      pageSize: 2,
      fetchPage,
    });

    expect(pools).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
