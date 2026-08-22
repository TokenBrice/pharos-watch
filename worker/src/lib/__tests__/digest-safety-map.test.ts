import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDigestSafetyMap } from "../digest-safety-map";

const NOW_SEC = 1_777_000_000;
const DATE = "2026-04-25";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    date: DATE,
    asOfSec: NOW_SEC - 60,
    renderedAtSec: NOW_SEC - 30,
    edition: "daily",
    bytes: { png: 1_234_567 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("digest Safety Score map resolution", () => {
  it("returns the dated image only after a current manifest and successful HEAD", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/safety-scores/map.json")) {
        return new Response(JSON.stringify(manifest()), { status: 200 });
      }
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toMatchObject({
      kind: "available",
      imageUrl: `https://pharos.watch/safety-scores/map.png?date=${DATE}`,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [manifest({ date: "2026-04-24" }), "manifest-not-today"],
    [manifest({ asOfSec: NOW_SEC - 86_400 }), "manifest-data-stale"],
    [manifest({ edition: "monthly" }), "manifest-invalid"],
  ])("omits a map that violates the publication contract", async (body, reason) => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toEqual({ kind: "unavailable", reason });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("omits a map when the dated image is absent", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest()), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toEqual({
      kind: "unavailable",
      reason: "image-http-404",
    });
  });
});
