import { CancelledError } from "@tanstack/query-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refetchQueryGroup } from "@/lib/query-refetch-group";

describe("refetchQueryGroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no failures when every refetch succeeds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refetchQueryGroup([
      () => Promise.resolve({ status: "success", error: null }),
      () => Promise.resolve({ data: { ok: true } }),
    ], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("counts fulfilled error-state refetch results as failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("query failed");

    const result = await refetchQueryGroup([
      () => Promise.resolve({ status: "error", error: failure }),
    ], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toEqual([failure]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith("[refetch] failed", [failure]);
  });

  it("counts rejected refetch promises as failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("network down");

    const result = await refetchQueryGroup([
      () => Promise.reject(failure),
    ], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toEqual([failure]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("ignores cancelled or aborted refetch failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refetchQueryGroup([
      () => Promise.reject(new CancelledError()),
      () => Promise.resolve({ status: "error", error: new DOMException("Aborted", "AbortError") }),
    ], {
      warnLabel: "[refetch] failed",
    });

    expect(result.failures).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
