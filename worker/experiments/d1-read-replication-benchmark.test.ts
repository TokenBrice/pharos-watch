import { afterEach, describe, expect, it, vi } from "vitest";
import d1ReadReplicationBenchmark from "./d1-read-replication-benchmark";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D1 read replication benchmark", () => {
  it("keeps query failure details out of the HTTP response", async () => {
    const failure = new Error("D1_ERROR: no such table: private_runtime_table");
    const all = vi.fn().mockRejectedValue(failure);
    const prepare = vi.fn(() => ({ all }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request("https://benchmark.example/?mode=primary&case=stablecoins-cache&asOf=1783814400", {
      headers: { Authorization: "Bearer benchmark-secret" },
    });

    const response = await d1ReadReplicationBenchmark.fetch(request, {
      BENCHMARK_TOKEN: "benchmark-secret",
      DB: { prepare } as unknown as D1Database,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      mode: "primary",
      case: "stablecoins-cache",
      error: "Benchmark query failed",
    });
    expect(log).toHaveBeenCalledWith("[d1-read-replication-benchmark] query failed", {
      mode: "primary",
      case: "stablecoins-cache",
      asOf: 1783814400,
      error: failure,
    });
  });
});
