import { describe, expect, it, vi } from "vitest";
import { fetchPagedTokenPools } from "../paged-token-pools";

describe("fetchPagedTokenPools", () => {
  it("starts at page one and stops after a short page", async () => {
    const pages = new Map([[1, [1, 2]], [2, [3]]]);
    const fetchPage = vi.fn(async (page: number) => pages.get(page)!);
    expect(await fetchPagedTokenPools({ maxPages: 4, pageSize: 2, fetchPage })).toEqual({
      rows: [1, 2, 3],
      complete: true,
      cappedAtMaxPages: false,
      failedAfterRows: null,
    });
    expect(fetchPage.mock.calls).toEqual([[1], [2]]);
  });

  it("stops immediately on an empty page", async () => {
    const fetchPage = vi.fn(async () => []);
    expect(await fetchPagedTokenPools({ maxPages: 3, pageSize: 2, fetchPage })).toMatchObject({
      rows: [],
      complete: true,
    });
    expect(fetchPage.mock.calls).toEqual([[1]]);
  });

  it("reports a cap-bounded scan as incomplete", async () => {
    const fetchPage = vi.fn(async (page: number) => [page * 2 - 1, page * 2]);
    expect(await fetchPagedTokenPools({ maxPages: 3, pageSize: 2, fetchPage })).toEqual({
      rows: [1, 2, 3, 4, 5, 6],
      complete: false,
      cappedAtMaxPages: true,
      failedAfterRows: null,
    });
    expect(fetchPage.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("makes no request for a zero cap", async () => {
    const fetchPage = vi.fn(async () => [1]);
    expect(await fetchPagedTokenPools({ maxPages: 0, pageSize: 1, fetchPage })).toMatchObject({
      rows: [],
      complete: false,
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("keeps earlier rows but never completes when a later page fails", async () => {
    const fetchPage = vi.fn(async (page: number) =>
      page === 2 ? ({ pageFailed: true } as const) : [page],
    );
    expect(await fetchPagedTokenPools({ maxPages: 3, pageSize: 1, fetchPage })).toEqual({
      rows: [1],
      complete: false,
      cappedAtMaxPages: false,
      failedAfterRows: 1,
    });
    expect(fetchPage.mock.calls).toEqual([[1], [2]]);
  });

  it("propagates a thrown page error rather than returning partial data", async () => {
    const error = new Error("page one failed");
    const fetchPage = vi.fn(async () => {
      throw error;
    });
    await expect(fetchPagedTokenPools({ maxPages: 3, pageSize: 1, fetchPage })).rejects.toBe(error);
  });
});
