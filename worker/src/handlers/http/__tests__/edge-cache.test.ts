import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeEdgeCache } from "../edge-cache";

function makeContext() {
  return {
    cacheKey: new Request("https://api.pharos.watch/api/stablecoins"),
    skipCache: false,
  };
}

function makeExecutionContext() {
  return {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

describe("writeEdgeCache", () => {
  const put = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.restoreAllMocks();
    put.mockReset();
    vi.stubGlobal("caches", { default: { put } });
  });

  it("stores cacheable successful responses", async () => {
    const ctx = makeExecutionContext();
    const response = new Response("{}", {
      status: 200,
      headers: { "Cache-Control": "public, s-maxage=60, max-age=10" },
    });

    writeEdgeCache(makeContext(), response, ctx);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));

    expect(put).toHaveBeenCalledOnce();
  });

  it("skips no-store, no-cache, and private responses", () => {
    for (const cacheControl of ["no-store", "public, no-cache", "private, max-age=60"]) {
      const ctx = makeExecutionContext();
      const response = new Response("{}", {
        status: 200,
        headers: { "Cache-Control": cacheControl },
      });

      writeEdgeCache(makeContext(), response, ctx);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    }
    expect(put).not.toHaveBeenCalled();
  });

  it("contains cache put failures inside waitUntil", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    put.mockRejectedValueOnce(new Error("cache unavailable"));
    const ctx = makeExecutionContext();

    writeEdgeCache(makeContext(), new Response("{}", { status: 200 }), ctx);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));

    expect(warn).toHaveBeenCalledWith("[edge-cache] Failed to write response:", expect.any(Error));
  });
});
