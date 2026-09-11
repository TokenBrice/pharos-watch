import { describe, expect, it, vi } from "vitest";
import { fetchPagedTokenPools } from "../paged-token-pools";

describe("fetchPagedTokenPools", () => {
  it("starts at page one and stops after a short page", async () => {
    const pages = new Map([[1, [1, 2]], [2, [3]]]);
    const fetchPage = vi.fn(async (page: number) => pages.get(page)!);
    expect(await fetchPagedTokenPools({ maxPages: 4, pageSize: 2, fetchPage })).toEqual([1, 2, 3]);
    expect(fetchPage.mock.calls).toEqual([[1], [2]]);
  });

  it("stops immediately on an empty page", async () => {
    const fetchPage = vi.fn(async () => []);
    expect(await fetchPagedTokenPools({ maxPages: 3, pageSize: 2, fetchPage })).toEqual([]);
    expect(fetchPage.mock.calls).toEqual([[1]]);
  });

  it("advances through full pages only as far as the cap", async () => {
    const fetchPage = vi.fn(async (page: number) => [page * 2 - 1, page * 2]);
    expect(await fetchPagedTokenPools({ maxPages: 3, pageSize: 2, fetchPage })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fetchPage.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("makes no request for a zero cap", async () => {
    const fetchPage = vi.fn(async () => [1]);
    expect(await fetchPagedTokenPools({ maxPages: 0, pageSize: 1, fetchPage })).toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("propagates a later-page error rather than returning partial data", async () => {
    const error = new Error("page two failed");
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 2) throw error;
      return [page];
    });
    await expect(fetchPagedTokenPools({ maxPages: 3, pageSize: 1, fetchPage })).rejects.toBe(error);
    expect(fetchPage.mock.calls).toEqual([[1], [2]]);
  });
});
