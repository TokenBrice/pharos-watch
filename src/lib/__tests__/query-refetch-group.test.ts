import { CancelledError } from "@tanstack/query-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQueryFreshnessGroup, refetchQueryGroup } from "@/lib/query-refetch-group";

describe("refetchQueryGroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no failures when every refetch succeeds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refetchQueryGroup(
      [() => Promise.resolve({ status: "success", error: null }), () => Promise.resolve({ data: { ok: true } })],
      {
        warnLabel: "[refetch] failed",
      },
    );

    expect(result.failures).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("counts fulfilled error-state refetch results as failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("query failed");

    const result = await refetchQueryGroup([() => Promise.resolve({ status: "error", error: failure })], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toEqual([failure]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith("[refetch] failed", [failure]);
  });

  it("counts rejected refetch promises as failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("network down");

    const result = await refetchQueryGroup([() => Promise.reject(failure)], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toEqual([failure]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("ignores cancelled or aborted refetch failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refetchQueryGroup(
      [
        () => Promise.reject(new CancelledError()),
        () => Promise.resolve({ status: "error", error: new DOMException("Aborted", "AbortError") }),
      ],
      {
        warnLabel: "[refetch] failed",
      },
    );

    expect(result.failures).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("synthesizes an Error for a fulfilled refetch reporting an error state without a cause", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refetchQueryGroup([() => Promise.resolve({ status: "error" })], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(Error);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("counts a fulfilled refetch carrying a non-null error without an error status", async () => {
    const failure = new Error("silent query failure");

    const result = await refetchQueryGroup([() => Promise.resolve({ error: failure })]);

    expect(result.failures).toEqual([failure]);
  });

  it("reports every settlement with failures ordered by refetcher, not by completion order", async () => {
    const firstFailure = new Error("summary failed");
    const secondFailure = new Error("detail failed");
    let rejectSlow!: (reason: unknown) => void;
    let rejectFast!: (reason: unknown) => void;
    const slow = new Promise<never>((_, reject) => { rejectSlow = reject; });
    const fast = new Promise<never>((_, reject) => { rejectFast = reject; });

    const resultPromise = refetchQueryGroup([
      () => Promise.resolve({ status: "success" }),
      () => Promise.reject(new CancelledError()),
      () => slow,
      () => fast,
    ]);

    rejectFast(secondFailure); // the later refetcher settles first
    rejectSlow(firstFailure);

    const result = await resultPromise;
    expect(result.results.map((entry) => entry.status)).toEqual(["fulfilled", "rejected", "rejected", "rejected"]);
    expect(result.failures).toEqual([firstFailure, secondFailure]);
  });

  it("propagates a synchronous refetcher throw without starting later refetchers", async () => {
    // audit: s095-src/C2 — the aggregation contract for synchronous throws is
    // a pending policy decision; this pins current behavior only.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const afterThrow = vi.fn();

    await expect(
      refetchQueryGroup([
        () => {
          throw new Error("sync throw");
        },
        afterThrow,
      ]),
    ).rejects.toThrow("sync throw");
    expect(afterThrow).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("buildQueryFreshnessGroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds freshness notices, global error, and data presence from query-like entries", async () => {
    const failure = new Error("peg summary failed");
    const refetchStablecoins = vi.fn().mockResolvedValue({ status: "success" });
    const refetchPeg = vi.fn().mockRejectedValue(failure);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const group = buildQueryFreshnessGroup(
      [
        {
          preset: "stablecoins",
          data: { peggedAssets: [] },
          dataUpdatedAt: 100,
          error: null,
          refetch: refetchStablecoins,
        },
        {
          preset: "pegSummary",
          data: undefined,
          dataUpdatedAt: 0,
          error: failure,
          refetch: refetchPeg,
        },
      ],
      {
        warnLabel: "[query-group] refetch failed",
      },
    );

    expect(group.globalError).toBe(failure);
    expect(group.hasAnyData).toBe(true);
    expect(group.queries.map((query) => [query.preset, query.dataUpdatedAt, query.hasData, query.error])).toEqual([
      ["stablecoins", 100, true, null],
      ["pegSummary", 0, false, failure],
    ]);

    const result = await group.refetchAll();
    expect(refetchStablecoins).toHaveBeenCalledOnce();
    expect(refetchPeg).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([failure]);
    expect(warnSpy).toHaveBeenCalledWith("[query-group] refetch failed", [failure]);
  });

  it("honors explicit hasData for falsey-but-valid payloads", () => {
    const group = buildQueryFreshnessGroup([
      {
        label: "Count",
        data: 0,
        dataUpdatedAt: 1,
        error: null,
      },
      {
        label: "Disabled detail",
        data: false,
        dataUpdatedAt: 2,
        hasData: false,
        error: null,
      },
    ]);

    expect(group.hasAnyData).toBe(true);
    expect(group.queries.map((query) => query.hasData)).toEqual([true, false]);
  });

  it("selects the first entry error as the group's global error", () => {
    const first = new Error("list failed");
    const second = new Error("chart failed");

    const group = buildQueryFreshnessGroup([
      { preset: "chains", dataUpdatedAt: 1, error: first },
      { preset: "dexLiquidity", dataUpdatedAt: 2, error: second },
    ]);

    expect(group.globalError).toBe(first);
  });

  it("refetches only entries that expose a refetch function", async () => {
    const failure = new Error("chart refetch failed");
    const refetchList = vi.fn().mockResolvedValue({ status: "success" });
    const refetchChart = vi.fn().mockRejectedValue(failure);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const group = buildQueryFreshnessGroup([
      { preset: "chains", dataUpdatedAt: 1, error: null, refetch: refetchList },
      { preset: "bluechip", dataUpdatedAt: 2, error: null },
      { preset: "dexLiquidity", dataUpdatedAt: 3, error: null, refetch: refetchChart },
    ], { warnLabel: "[query-group] refetch failed" });

    const result = await group.refetchAll();
    expect(refetchList).toHaveBeenCalledOnce();
    expect(refetchChart).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([failure]);
    expect(warnSpy).toHaveBeenCalledWith("[query-group] refetch failed", [failure]);
  });
});
