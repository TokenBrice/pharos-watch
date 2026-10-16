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

});
