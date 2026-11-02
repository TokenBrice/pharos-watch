import { describe, expect, it, vi } from "vitest";

const apiFetchWithMetaMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetchWithMeta: (...args: unknown[]) => apiFetchWithMetaMock(...args),
}));

import { fetchCompleteDigestArchive } from "@/hooks/api-hooks";

describe("fetchCompleteDigestArchive", () => {
  it("follows the archive cursor to completion and keeps the first generation's meta", async () => {
    apiFetchWithMetaMock
      .mockResolvedValueOnce({
        data: {
          digests: [{ generatedAt: 3 }],
          pagination: { horizon: 5, total: 3, scanned: 1, nextCursor: "c1" },
        },
        meta: null,
      })
      .mockResolvedValueOnce({
        data: {
          digests: [{ generatedAt: 2 }],
          pagination: { horizon: 5, total: 3, scanned: 2, nextCursor: "c2" },
        },
        meta: { updatedAt: 1_700_000_000 },
      })
      .mockResolvedValueOnce({
        data: {
          digests: [{ generatedAt: 1 }],
          pagination: { horizon: 5, total: 3, scanned: 3, nextCursor: null },
        },
        meta: null,
      });

    const result = await fetchCompleteDigestArchive();

    expect(result.data.digests.map((entry) => entry.generatedAt)).toEqual([3, 2, 1]);
    expect(result.meta).toEqual({ updatedAt: 1_700_000_000 });
    expect(apiFetchWithMetaMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/digest-archive?history=all",
      "/api/digest-archive?history=all&cursor=c1",
      "/api/digest-archive?history=all&cursor=c2",
    ]);
  });

  it("fails closed on a repeated cursor instead of looping or truncating silently", async () => {
    apiFetchWithMetaMock
      .mockResolvedValueOnce({
        data: {
          digests: [{ generatedAt: 2 }],
          pagination: { horizon: 5, total: 3, scanned: 1, nextCursor: "c1" },
        },
        meta: null,
      })
      .mockResolvedValueOnce({
        data: {
          digests: [{ generatedAt: 1 }],
          pagination: { horizon: 5, total: 3, scanned: 2, nextCursor: "c1" },
        },
        meta: null,
      });

    await expect(fetchCompleteDigestArchive()).rejects.toThrow("pagination cursor repeated");
  });
});
