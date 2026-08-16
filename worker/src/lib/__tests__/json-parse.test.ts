import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  tryParseJson,
} from "../json-parse";

describe("json parse helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid JSON and preserves JSON null values", () => {
    expect(parseJson(JSON.stringify({ ok: true }))).toEqual({ ok: true, value: { ok: true } });
    expect(tryParseJson("null")).toBeNull();
  });

  it("returns fallback arrays while filtering non-string entries", () => {
    expect(parseJsonStringArray(JSON.stringify(["a", 1, "b", null]))).toEqual(["a", "b"]);
    expect(parseJsonStringArray(JSON.stringify({ not: "array" }), undefined, ["fallback"])).toEqual(["fallback"]);
    expect(parseJsonStringArray(null, undefined, ["fallback"])).toEqual(["fallback"]);
  });

  it("returns fallback objects only for object payloads", () => {
    expect(parseJsonObject<{ value: number }>(JSON.stringify({ value: 1 }))).toEqual({ value: 1 });
    expect(parseJsonObject(JSON.stringify(["not-object"]), undefined, { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it("emits context-aware parse failures when requested", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const parsed = parseJson("{bad-json", "test-context");

    expect(parsed.ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[json-parse] Failed to parse JSON (test-context):"),
    );
  });

  it("lets callers record parse failures without console warnings", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failures: Array<{ context?: string; message: string }> = [];

    const parsed = parseJson("{bad-json", {
      context: "custom-recorder",
      onFailure: (failure) => failures.push(failure),
    });

    expect(parsed.ok).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.context).toBe("custom-recorder");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
