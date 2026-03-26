import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectEndpointProbes, ENDPOINT_PROBE_CONCURRENCY } from "../use-endpoint-probes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("collectEndpointProbes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels unread bodies for non-semantic probe routes", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
    } as unknown as Response);

    const result = await collectEndpointProbes(["/api/chains"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toEqual([
      expect.objectContaining({
        path: "/api/chains",
        status: 200,
      }),
    ]);
  });

  it("limits concurrent browser probes to avoid transport saturation", async () => {
    const paths = Array.from(
      { length: ENDPOINT_PROBE_CONCURRENCY + 2 },
      (_value, index) => `/api/test-${index}`,
    );
    const deferreds = paths.map(() => createDeferred<Response>());
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const deferred = deferreds[started.length]!;
      started.push(String(input));
      active += 1;
      maxActive = Math.max(maxActive, active);
      return deferred.promise.finally(() => {
        active -= 1;
      });
    });

    const probePromise = collectEndpointProbes(paths);
    await Promise.resolve();

    expect(started).toHaveLength(ENDPOINT_PROBE_CONCURRENCY);

    deferreds[0]!.resolve(new Response(""));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toHaveLength(ENDPOINT_PROBE_CONCURRENCY + 1);

    for (const deferred of deferreds.slice(1)) {
      deferred.resolve(new Response(""));
    }

    await probePromise;

    expect(maxActive).toBe(ENDPOINT_PROBE_CONCURRENCY);
  });
});
